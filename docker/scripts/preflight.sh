#!/usr/bin/env bash
#
# Pre-deployment checks. Run on the VM, from the repo root, BEFORE the first
# build and before any DNS change:
#
#   bash docker/scripts/preflight.sh
#
# Everything here is read-only — it starts nothing and changes nothing. The
# point is to fail on the box, in ten minutes, rather than halfway through a
# cutover.
#
# The check that matters most is #4. Binance's futures endpoint completed its
# TLS and WebSocket handshake from Render, logged a cheerful "connected", and
# then delivered zero bytes forever — a silent geo-restriction. So the pass
# condition is MESSAGES RECEIVED, never a successful connection.

set -uo pipefail

PASS=0; FAIL=0; WARN=0
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
warn() { echo "  ! $*"; WARN=$((WARN+1)); }
hdr()  { echo; echo "── $* ────────────────────────────────────────"; }

echo "StockLabs preflight — $(date -Is)"

# ---------------------------------------------------------------------------
hdr "1. Host"
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version | sed 's/Docker version //;s/,.*//')"
else
  bad "docker not installed"
fi

if docker compose version >/dev/null 2>&1; then
  ok "compose plugin $(docker compose version --short 2>/dev/null)"
else
  bad "docker compose plugin missing (need v2, not docker-compose v1)"
fi

docker info >/dev/null 2>&1 && ok "docker daemon reachable" || bad "docker daemon not running / needs sudo"

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if   [ "$MEM_MB" -ge 7500 ]; then ok "RAM ${MEM_MB}MB — comfortable for scaling"
elif [ "$MEM_MB" -ge 3800 ]; then warn "RAM ${MEM_MB}MB — enough for api=1 (~2.4GB budget), tight beyond api=2"
else bad "RAM ${MEM_MB}MB — below the ~2.4GB the stack budgets at api=1"; fi

DISK_GB=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')
[ "${DISK_GB:-0}" -ge 20 ] && ok "disk ${DISK_GB}GB free" || warn "disk ${DISK_GB}GB free — images + pgdata + backups want 20GB+"

ARCH=$(uname -m)
[ "$ARCH" = "x86_64" ] && ok "arch $ARCH" || warn "arch $ARCH — base images are multi-arch, but verify bcrypt/prisma build"

# ---------------------------------------------------------------------------
hdr "2. Ports"
# ---------------------------------------------------------------------------
for p in 80 443; do
  if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$p )" 2>/dev/null | grep -q ":$p"; then
    bad "port $p already in use — nginx will fail to bind (apache2? another nginx?)"
  else
    ok "port $p free"
  fi
done

# ---------------------------------------------------------------------------
hdr "3. Binance REST"
# ---------------------------------------------------------------------------
COUNTRY=$(curl -s --max-time 10 https://ipinfo.io/country 2>/dev/null | tr -d '\n\r ')
echo "  egress country: ${COUNTRY:-unknown}"
case "$COUNTRY" in
  US|GB|JP) warn "country $COUNTRY is commonly restricted by binance.com — check 4 closely" ;;
  "")       warn "could not determine egress country" ;;
  *)        ok "country $COUNTRY" ;;
esac

CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://api.binance.com/api/v3/exchangeInfo 2>/dev/null)
case "$CODE" in
  200) ok "api.binance.com/exchangeInfo -> 200" ;;
  451) bad "api.binance.com -> 451 (legally restricted from this IP). Hard stop." ;;
  *)   bad "api.binance.com -> ${CODE:-no response}" ;;
esac

# ---------------------------------------------------------------------------
hdr "4. Binance WebSocket — THE go/no-go check"
# ---------------------------------------------------------------------------
WS_BASE="${BINANCE_WS_BASE:-wss://stream.binance.com:9443}"
echo "  endpoint: $WS_BASE"
echo "  pass condition: MESSAGES RECEIVED (a handshake alone proves nothing)"

cat > /tmp/.binance-probe.cjs <<'PROBE'
const WebSocket = require("ws");
const base = process.env.WS_BASE;
const ws = new WebSocket(`${base}/stream?streams=btcusdt@ticker/ethusdt@ticker`);
let n = 0;
ws.on("open", () => console.log("     handshake OK, waiting 15s..."));
ws.on("message", (b) => {
  if (++n === 1) {
    const f = JSON.parse(b.toString());
    console.log(`     first tick: ${f.stream} @ ${f.data && f.data.c}`);
  }
});
ws.on("error", (e) => console.log("     ws error: " + e.message));
setTimeout(() => { console.log("MSGS=" + n); process.exit(n > 0 ? 0 : 1); }, 15000);
PROBE

WS_OUT=$(docker run --rm --network host \
  -e WS_BASE="$WS_BASE" \
  -v /tmp/.binance-probe.cjs:/probe.cjs:ro \
  node:22-bookworm-slim \
  sh -c 'npm i -g ws --silent >/dev/null 2>&1 && NODE_PATH=$(npm root -g) node /probe.cjs' 2>&1)
echo "$WS_OUT" | grep -v '^MSGS=' | sed 's/^/  /'
MSGS=$(echo "$WS_OUT" | grep '^MSGS=' | cut -d= -f2)

if [ "${MSGS:-0}" -gt 0 ]; then
  ok "Binance feed live — $MSGS messages in 15s"
else
  bad "SILENT. Handshake may have succeeded but no data arrived."
  echo "     This is the geo-restriction signature. Retry with the fallback:"
  echo "       BINANCE_WS_BASE=wss://data-stream.binance.vision bash docker/scripts/preflight.sh"
  echo "     If that passes, set BINANCE_WS_BASE in .env.prod — no rebuild needed."
fi
rm -f /tmp/.binance-probe.cjs

# ---------------------------------------------------------------------------
hdr "5. Third-party commodity feed"
# ---------------------------------------------------------------------------
echo "  (free tier — a 30-60s cold start is normal, allowing 75s)"
CF=$(timeout 75 curl -sN --max-time 75 -H 'Accept: text/event-stream' \
     https://ssj-server-om8r.onrender.com/api/prices/stream 2>/dev/null | head -c 2000)
if echo "$CF" | grep -q 'prices:update'; then
  ok "commodity feed delivering prices:update events"
elif [ -n "$CF" ]; then
  warn "commodity feed responded but no prices:update seen yet (may still be waking)"
else
  warn "commodity feed silent — commodity ORDERS will 503; crypto is unaffected"
fi

# ---------------------------------------------------------------------------
hdr "6. Outbound — email"
# ---------------------------------------------------------------------------
RC=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://api.resend.com 2>/dev/null)
[ -n "$RC" ] && [ "$RC" != "000" ] && ok "api.resend.com reachable (HTTP $RC)" \
  || bad "api.resend.com unreachable — password reset and welcome mail will not send"

# ---------------------------------------------------------------------------
hdr "7. DNS"
# ---------------------------------------------------------------------------
DOMAIN="${ACME_DOMAIN:-}"
[ -z "$DOMAIN" ] && [ -f .env.prod ] && DOMAIN=$(grep -E '^ACME_DOMAIN=' .env.prod | cut -d= -f2- | tr -d '"'"'"' \r')
if [ -z "$DOMAIN" ]; then
  warn "no ACME_DOMAIN set yet — skipping (needed before certs)"
else
  MYIP=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null)
  RESOLVED=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
  echo "  domain: $DOMAIN   vm ip: ${MYIP:-?}   resolves to: ${RESOLVED:-nothing}"
  if [ -z "$RESOLVED" ]; then
    warn "$DOMAIN does not resolve yet — certs will fail until the A record exists"
  elif [ "$RESOLVED" = "$MYIP" ]; then
    ok "$DOMAIN -> this VM"
  else
    warn "$DOMAIN points at $RESOLVED, not this VM ($MYIP) — DNS may still be propagating"
  fi
fi

# ---------------------------------------------------------------------------
hdr "8. Config"
# ---------------------------------------------------------------------------
if [ -f .env.prod ]; then
  ok ".env.prod present"
  LEFT=$(grep -c 'CHANGEME' .env.prod || true)
  [ "$LEFT" -eq 0 ] && ok "no CHANGEME placeholders left" || bad "$LEFT CHANGEME placeholder(s) still in .env.prod"
  for v in JWT_SECRET JWT_REFRESH_SECRET POSTGRES_PASSWORD DATABASE_URL REDIS_URL; do
    val=$(grep -E "^$v=" .env.prod | cut -d= -f2-)
    [ -n "$val" ] && ok "$v set" || bad "$v empty"
  done
  grep -qE '^RESEND_API_KEY=.+' .env.prod \
    && ok "RESEND_API_KEY set" \
    || warn "RESEND_API_KEY empty — server boots, but password reset silently does nothing"
  PGPW=$(grep -E '^POSTGRES_PASSWORD=' .env.prod | cut -d= -f2-)
  if [ -n "$PGPW" ] && grep -qE "^DATABASE_URL=.*:${PGPW}@" .env.prod; then
    ok "DATABASE_URL password matches POSTGRES_PASSWORD"
  else
    bad "DATABASE_URL password does NOT match POSTGRES_PASSWORD — migrate will fail to authenticate"
  fi
  grep -qE '^DATABASE_URL=.*connection_limit=' .env.prod \
    && ok "DATABASE_URL sets connection_limit" \
    || warn "no connection_limit — N replicas will exhaust Postgres max_connections"
else
  bad ".env.prod missing — cp .env.example .env.prod and fill it in"
fi

# ---------------------------------------------------------------------------
echo
echo "═══════════════════════════════════════════════"
printf "  %d passed   %d warnings   %d failed\n" "$PASS" "$WARN" "$FAIL"
echo "═══════════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  echo "  Resolve the ✗ items before building."
  exit 1
fi
echo "  Clear to build:"
echo "    docker compose -f docker-compose.prod.yml build"
[ "$WARN" -gt 0 ] && echo "  (review the ! items — none block the build)"
exit 0
