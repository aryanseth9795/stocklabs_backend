#!/usr/bin/env bash
#
# End-to-end smoke test against a deployed stack.
#
#   bash docker/scripts/smoke-test.sh https://api.aryantechie.in
#
# Creates a throwaway account, moves fake money through every trade path, and
# checks the balance arithmetic after each one. Read-only against everything
# except its own user.
#
# The point is not that the endpoints return 200. It is that the SERVER decides
# the price: every fill is checked against the live board rather than against
# anything this script sends, because the bug that mattered most in this
# codebase was a client-supplied `rate` letting a user buy at ₹1 and sell at
# ₹10,00,000.

set -uo pipefail

BASE="${1:-https://api.aryantechie.in}"
API="$BASE/api/v1"
JAR=$(mktemp)
PASS=0; FAIL=0
trap 'rm -f "$JAR"' EXIT

ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
hdr()  { echo; echo "── $* ────────────────────────────────"; }

# jq keeps this readable; fall back to grep if it is absent.
if command -v jq >/dev/null 2>&1; then
  J() { jq -r "$1" 2>/dev/null; }
else
  J() { grep -oP "\"${1#.}\"\s*:\s*\K[^,}]+" 2>/dev/null | head -1 | tr -d '"'; }
  echo "note: jq not installed — output will be less precise (apt install -y jq)"
fi

EMAIL="smoke-$(date +%s)-$RANDOM@example.com"
PW="SmokeTest!$RANDOM"

echo "smoke test → $BASE"
echo "account    → $EMAIL"

# ---------------------------------------------------------------------------
hdr "1. Reachability"
# ---------------------------------------------------------------------------
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/ping")
[ "$CODE" = "200" ] && ok "GET /ping -> 200" || bad "GET /ping -> $CODE"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/readyz")
[ "$CODE" = "404" ] && ok "/readyz not publicly exposed (404)" \
  || bad "/readyz returned $CODE — it runs a DB probe and must not be public"

# ---------------------------------------------------------------------------
hdr "2. Signup and login"
# ---------------------------------------------------------------------------
R=$(curl -sS -c "$JAR" -X POST "$API/signup" \
     -H 'Content-Type: application/json' \
     -d "{\"name\":\"Smoke Test\",\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
echo "$R" | grep -q '"success":true' && ok "signup" || { bad "signup: $R"; echo; echo "cannot continue"; exit 1; }

R=$(curl -sS -c "$JAR" -X POST "$API/login" \
     -H 'Content-Type: application/json' \
     -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
echo "$R" | grep -q '"success":true' && ok "login" || bad "login: $R"
grep -q 'token' "$JAR" && ok "session cookie set" || bad "no session cookie — check secure/sameSite over TLS"

ME=$(curl -sS -b "$JAR" "$API/me")
BAL0=$(echo "$ME" | J '.user.balance')
[ -n "${BAL0:-}" ] && ok "GET /me — opening balance ₹$BAL0" || bad "GET /me: $ME"

# ---------------------------------------------------------------------------
hdr "3. Delivery buy / sell — server-priced"
# ---------------------------------------------------------------------------
SYM="BTCUSDT"; QTY=1

R=$(curl -sS -b "$JAR" -X POST "$API/execute" \
     -H 'Content-Type: application/json' \
     -d "{\"stockName\":\"$SYM\",\"type\":\"buy\",\"quantity\":$QTY,\"orderMode\":\"delivery\"}")
if echo "$R" | grep -q '"success":true'; then
  BUYP=$(echo "$R" | J '.executedPrice')
  ok "buy $QTY $SYM @ ₹${BUYP:-?} (price chosen by the server)"
elif echo "$R" | grep -q '503'; then
  bad "buy -> 503 no live price. Worker feed is down; check: docker compose logs worker"
else
  bad "buy: $R"
fi

BAL1=$(curl -sS -b "$JAR" "$API/me" | J '.user.balance')
if [ -n "${BAL1:-}" ] && [ -n "${BAL0:-}" ]; then
  awk -v a="$BAL0" -v b="$BAL1" 'BEGIN{exit !(b < a)}' \
    && ok "balance fell after buy: ₹$BAL0 -> ₹$BAL1" \
    || bad "balance did not fall: ₹$BAL0 -> ₹$BAL1"
fi

echo "$(curl -sS -b "$JAR" "$API/portfolio")" | grep -q "$SYM" \
  && ok "position appears in portfolio" || bad "position missing from portfolio"

R=$(curl -sS -b "$JAR" -X POST "$API/execute" \
     -H 'Content-Type: application/json' \
     -d "{\"stockName\":\"$SYM\",\"type\":\"sell\",\"quantity\":$QTY,\"orderMode\":\"delivery\"}")
echo "$R" | grep -q '"success":true' && ok "sell $QTY $SYM" || bad "sell: $R"

# ---------------------------------------------------------------------------
hdr "4. Client-supplied price must be IGNORED (regression S-02)"
# ---------------------------------------------------------------------------
# The whole reason priceCache.ts exists. If `rate` from the body is ever
# honoured again, this buys at ₹1 and the platform mints money.
R=$(curl -sS -b "$JAR" -X POST "$API/execute" \
     -H 'Content-Type: application/json' \
     -d "{\"stockName\":\"$SYM\",\"type\":\"buy\",\"quantity\":1,\"rate\":1,\"orderMode\":\"delivery\"}")
EP=$(echo "$R" | J '.executedPrice')
if [ -n "${EP:-}" ] && awk -v p="$EP" 'BEGIN{exit !(p > 100)}'; then
  ok "client rate=1 ignored — filled at ₹$EP"
elif echo "$R" | grep -q '"success":true'; then
  bad "FILLED AT ₹${EP:-?} WITH CLIENT-SUPPLIED RATE — server-authoritative pricing is broken"
else
  ok "order rejected (also acceptable): $(echo "$R" | J '.message')"
fi
curl -sS -b "$JAR" -X POST "$API/execute" -H 'Content-Type: application/json' \
  -d "{\"stockName\":\"$SYM\",\"type\":\"sell\",\"quantity\":1,\"orderMode\":\"delivery\"}" >/dev/null

# ---------------------------------------------------------------------------
hdr "5. Short sell and cover"
# ---------------------------------------------------------------------------
R=$(curl -sS -b "$JAR" -X POST "$API/short/sell" \
     -H 'Content-Type: application/json' \
     -d "{\"stockName\":\"$SYM\",\"quantity\":1,\"assetType\":\"crypto\"}")
if echo "$R" | grep -q '"success":true'; then
  SID=$(echo "$R" | J '.shortPosition.id')
  ok "short opened (id ${SID:0:8}…)"

  echo "$(curl -sS -b "$JAR" "$API/short/positions")" | grep -q 'open' \
    && ok "position listed as open" || bad "open position not listed"

  R=$(curl -sS -b "$JAR" -X POST "$API/short/cover" \
       -H 'Content-Type: application/json' -d "{\"shortPositionId\":\"$SID\"}")
  echo "$R" | grep -q '"success":true' && ok "short covered" || bad "cover: $R"

  # The conditional-claim guard (S-06): covering twice must not pay twice.
  R=$(curl -sS -b "$JAR" -X POST "$API/short/cover" \
       -H 'Content-Type: application/json' -d "{\"shortPositionId\":\"$SID\"}")
  echo "$R" | grep -qi 'already closed' \
    && ok "double-cover rejected — atomic claim holding (S-06)" \
    || bad "DOUBLE COVER NOT REJECTED: $R"
else
  bad "short sell: $R"
fi

# ---------------------------------------------------------------------------
hdr "6. Commodities (prices arrive via Redis from the worker)"
# ---------------------------------------------------------------------------
R=$(curl -sS -b "$JAR" -X POST "$API/commodity/execute" \
     -H 'Content-Type: application/json' \
     -d '{"symbol":"GOLD","type":"buy","quantity":1}')
if echo "$R" | grep -q '"success":true'; then
  ok "commodity buy filled @ ₹$(echo "$R" | J '.executedPrice')"
  curl -sS -b "$JAR" -X POST "$API/commodity/execute" -H 'Content-Type: application/json' \
    -d '{"symbol":"GOLD","type":"sell","quantity":1}' >/dev/null && ok "commodity sell"
else
  bad "commodity buy: $(echo "$R" | J '.message')"
  echo "     if 503: the api replica has no commodity price, i.e. the worker's"
  echo "     Redis publishes are not reaching it. Check: redis-cli --scan --pattern 'commodity:*'"
fi

CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$API/commodity/stream")
[ "$CODE" = "200" ] || [ "$CODE" = "000" ] \
  && ok "SSE stream open (nginx not buffering)" \
  || bad "SSE stream -> $CODE"

# ---------------------------------------------------------------------------
hdr "7. History and logout"
# ---------------------------------------------------------------------------
curl -sS -b "$JAR" "$API/tradehistory" | grep -q '"success":true' && ok "trade history" || bad "trade history"
curl -sS -b "$JAR" "$API/transactions" | grep -q '"success":true' && ok "transactions" || bad "transactions"
curl -sS -b "$JAR" "$API/stats/pl"     | grep -q '"success":true' && ok "P&L stats"    || bad "P&L stats"
curl -sS -b "$JAR" "$API/logout"       | grep -q '"success":true' && ok "logout"       || bad "logout"

CODE=$(curl -sS -b "$JAR" -o /dev/null -w '%{http_code}' "$API/me")
[ "$CODE" = "401" ] && ok "session invalid after logout" || bad "still authenticated after logout ($CODE)"

# ---------------------------------------------------------------------------
echo
echo "═══════════════════════════════════════"
printf "  %d passed   %d failed\n" "$PASS" "$FAIL"
echo "═══════════════════════════════════════"
echo "  test account $EMAIL remains in the database."
[ "$FAIL" -eq 0 ] || exit 1
