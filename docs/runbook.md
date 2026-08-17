# Runbook

**Status: planned.** The stack described here does not exist yet — `Dockerfile`,
`docker-compose.prod.yml` and `docker/nginx/**` are still to be written, and no VM has been
provisioned. Commands are written as they are intended to be run so that they can be checked against
reality once the stack lands. Anything already true today is marked.

All commands assume you are in the repo root on the VM, on branch `prod`, with `.env.prod` present
(gitignored, never baked into an image).

```bash
export COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"
```

---

## Deploy

```bash
git pull origin prod
$COMPOSE build
$COMPOSE up -d                 # runs `migrate` to completion, then worker + api
$COMPOSE ps                    # all healthy; `migrate` shows Exited (0)
docker compose exec api curl -sf localhost:4000/readyz | jq
```

Service start order is enforced by compose, not by hand: `postgres` (healthcheck `pg_isready`) →
`migrate` (`prisma migrate deploy`, `restart: "no"`) → `worker` and `api`
(`depends_on: migrate: service_completed_successfully`).

If `migrate` exits non-zero, **stop**. The api and worker will not start, which is correct — do not
work around it by starting them manually.

## Scale

```bash
$COMPOSE up -d --scale api=4
$COMPOSE ps api                        # 4 containers
```

No Nginx edit and no reload: it re-resolves `api` through Docker DNS on the resolver TTL
([ADR 0005](./decisions/0005-nginx-dns-resolver-load-balancing.md)).

**Never scale `worker`.** It stays at exactly 1. The full list of what breaks otherwise is in
[scaling.md](./scaling.md#worker-stays-at-exactly-1).

Scaling down drops the replica's Socket.IO clients (they reconnect to a peer) and its SSE clients
(the mobile app reconnects). Both are expected; the graceful-shutdown sequence is what keeps in-flight
HTTP requests from failing.

## Rolling restart

Restart replicas one at a time so the fleet is never fully unavailable:

```bash
for c in $($COMPOSE ps -q api); do
  docker stop -t 45 "$c"       # >= stop_grace_period; app exits under its own watchdog at 15s
  $COMPOSE up -d --no-recreate --scale api=$(($($COMPOSE ps -q api | wc -l) + 1)) api
  sleep 10                     # let the new replica hydrate and pass /readyz
done
```

What makes this safe (all of it planned work, none of it live yet):

1. SIGTERM flips `/readyz` to 503 but the replica **keeps serving for ~8 s** while Nginx's DNS cache
   ages out. Skipping that drain is what makes "zero-downtime" deploys drop POSTs.
2. `io.local.disconnectSockets(true)` — **not** `io.disconnectSockets()`, which would kick every user
   on every replica ([gotchas.md](./gotchas.md#iodisconnectsockets-during-shutdown-kills-the-whole-fleet)).
3. SSE responses are ended explicitly, or `server.close()` never completes.

**Accepted residual risk:** the DNS deregistration window. For up to `valid=` seconds after a
container exits, Nginx may still hold its address; a POST landing there gets a 502 and is correctly
*not* retried. With `valid=1s` that is roughly one potentially-failed POST per replica per deploy. It
is inherent to DNS discovery on OSS Nginx and cannot be fully closed — see the ADR.

## Backup and verify

Nightly `pg_dump` runs from the `backup` service into a host-mounted volume with rotation. To take one
on demand:

```bash
$COMPOSE exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc stocklabs \
  > backups/stocklabs-$(date +%F-%H%M).dump
ls -lh backups/ | tail
```

**A backup you have never restored is not a backup.** Verify by restoring into a scratch database in
the same container:

```bash
$COMPOSE exec -T postgres createdb -U "$POSTGRES_USER" restore_check
$COMPOSE exec -T postgres pg_restore -U "$POSTGRES_USER" -d restore_check < backups/<file>.dump
$COMPOSE exec -T postgres psql -U "$POSTGRES_USER" -d restore_check \
  -c 'select count(*) from "User"; select count(*) from "Order";'
$COMPOSE exec -T postgres dropdb -U "$POSTGRES_USER" restore_check
```

Do this once when the stack goes up, and after any change to the backup service.

## Restore

```bash
$COMPOSE stop api worker                                     # stop writers first
$COMPOSE exec -T postgres dropdb   -U "$POSTGRES_USER" stocklabs
$COMPOSE exec -T postgres createdb -U "$POSTGRES_USER" stocklabs
$COMPOSE exec -T postgres pg_restore -U "$POSTGRES_USER" -d stocklabs < backups/<file>.dump
$COMPOSE up -d                                               # migrate re-runs, then api + worker
```

Redis needs no restore: everything in it is either regenerable within ~2 minutes from the live feeds
(`tick:*`, `commodity:*`) or intentionally ephemeral (OTPs, socket registry, adapter channels). Losing
Redis logs everyone's sockets out and invalidates in-flight OTPs; it does not lose money data.

## Certificates

Issued and renewed by the `certbot` service over the webroot challenge, with Nginx serving
`/.well-known/acme-challenge/`.

```bash
$COMPOSE run --rm certbot renew --dry-run     # test without touching rate limits
$COMPOSE run --rm certbot renew
$COMPOSE exec nginx nginx -s reload           # pick up renewed certs
```

Certificates expire in 90 days; the renewal job should run at least twice a week. If renewal starts
failing, check that port 80 is still open and that the challenge path is not being caught by a
`limit_req` or a catch-all redirect.

## Reading `/readyz`

`/healthz` = liveness ("the process is up"), no I/O, used by the Docker healthcheck to restart wedged
containers. `/readyz` = readiness, used to decide whether this replica should take traffic. Both
return **404 publicly** through Nginx — `/readyz` runs a DB probe, and exposing it is an
unauthenticated database-liveness oracle. Hit them on the container:

```bash
docker compose exec api    curl -sf localhost:4000/readyz | jq
docker compose exec worker curl -sf localhost:4000/readyz | jq
```

The governing rule: **`/readyz` may only fail on conditions that make *this* replica worse than its
peers.** A condition shared by the whole fleet is *reported*, never *gated* — gating on it pulls every
replica out of rotation at once, which is strictly worse than serving degraded.

| Role | Gates readiness (503 if false) | Reported only |
|---|---|---|
| `api` | not shutting down; this replica's `rSub.status === "ready"`; hydration finished or timed out; Prisma `SELECT 1` (memoised 5 s, so the endpoint cannot be turned into DB load) | board age and symbol count, commodity age, socket count, SSE count |
| `worker` | Binance socket open **and** a tick within 30 s | third-party commodity upstream |

Why the worker inverts: there is only one of it, so "unhealthy" *is* the alert rather than a routing
decision. And it gates on **ticks**, never on connection state alone — "connected but silent" is
exactly the failure that hid the geo-blocked futures endpoint for months, and is what the silence timer
at `app.ts:343-355` exists to catch. The commodity upstream stays reported-only: it is a free-tier
third party that will flap, and restarting the worker over it would drop the Binance feed as
collateral damage.

`/ping` (`app.ts:116-118`) still exists for backwards compatibility. It touches nothing and answers 200
while Postgres is down, Redis is unreachable and the feed is dead. Do not health-check on it.

## Triage

| Symptom | Check first |
|---|---|
| All trades return 503 "No live price available" | `worker` logs for `[Binance WS]`. Handshake-but-silent = geo/network block on the egress IP (`app.ts:343-355`). Then `redis-cli --scan --pattern 'tick:*'` inside the redis container — expect ~50 keys with TTL > 0. |
| Crypto works, commodities 503 | `worker` logs for `[Commodity]`. The upstream is a free-tier third party (`commodityFeed.ts:27-28`) and flaps. Check `commodity:*` keys and their TTLs. |
| Board frozen for *some* users only | One api replica's `rSub` died. `/readyz` on each replica; the bad one gates itself out. Restart it. |
| Board updates arriving N× per second | The 1 s broadcast is using `io.to()` instead of `io.local.to()` ([gotchas.md](./gotchas.md#the-board-broadcast-must-be-iolocalto)). |
| `[Redis] pmessage parse error` on every broadcast | The Socket.IO adapter is sharing `rSub` ([gotchas.md](./gotchas.md#the-socketio-adapter-needs-its-own-redis-clients)). |
| Password reset fails intermittently | OTP store is still the in-process `Map` (`userController.ts:39`), or Redis OTP keys are not being written. Failure rate ≈ (N−1)/N. |
| Second login does not kick the first session | Socket.IO Redis adapter missing, or `userSockets` still local (`app.ts:455`). |
| Containers SIGKILLed after 45 s on every deploy | Shell-form `CMD`, an un-ended SSE response, or an uncleared interval ([gotchas.md](./gotchas.md#shutdown)). |
| Every api replica logs "the price feed is DOWN" every 60 s | `logTop50FromRedis` is running in the api role; it must be worker-only (`app.ts:236-241`). |
| Web users cannot log in after deploy | `CORS_ORIGINS` missing the web origin, or TLS not terminating while `NODE_ENV=production` forces `secure` cookies (`userController.ts:64-65`). |
| Prisma "too many connections" | `(api_replicas + 1) × connection_limit` exceeds `max_connections`. Fix `connection_limit` in `DATABASE_URL`, not by scaling down. |
| `--scale api=N` gives N containers but one gets all traffic | Static Nginx `upstream` block instead of the resolver form ([gotchas.md](./gotchas.md#a-static-upstream-block-never-sees-new-replicas)). |
| Duplicate orders / double debits around deploys | `non_idempotent` in `proxy_next_upstream`. Remove it ([gotchas.md](./gotchas.md#proxy_next_upstream-non_idempotent-duplicates-trades)). |
| Disk filling up | `logging` json-file `max-size`/`max-file` caps missing on a service; or backup rotation not running. |

---

## Cutover

### Pre-flight — from the VM, before any DNS change

Run in order. Any failure stops the cutover.

1. **Binance spot WS reachable from the new egress IP.** Connect to
   `wss://stream.binance.com:9443` and confirm **messages actually arrive** — not just that the
   handshake completes. The futures endpoint was previously geo-blocked from Render in exactly this
   way: handshake fine, zero messages, silent (`review/phase-1-server.md:759-774`). With no live price
   every trade returns 503 by design, so this is a **go/no-go**.
2. **Commodity upstream reachable**: `https://ssj-server-om8r.onrender.com/api/prices/stream` returns
   `200` and an event stream.
3. **Firewall**: only 80/443 inbound. Confirm Postgres and Redis are unreachable from outside — from
   your laptop, `psql` and `redis-cli` against the VM's IP must both be refused.

### Sequence

4. Point `api.aryantechie.in` at the VM, issue certificates, bring the stack up. **Render keeps
   serving all live traffic throughout.**
5. Validate the new host directly — the full matrix below — while Render still owns the clients.
6. Add `https://api.aryantechie.in` to Render's CORS **and** the new stack's `CORS_ORIGINS`, so both
   hosts accept the web origin during the transition.
7. Flip the clients:
   - Web: edit `Frontend/.env.local` **and rebuild**. `NEXT_PUBLIC_*` is baked at build time, so an env
     edit alone does nothing.
   - Mobile: set `EXPO_PUBLIC_SERVER_URL` in `eas.json` (currently absent in every profile) and ship an
     EAS Update — installed apps repoint without a store release.
8. **Fix `App/src/config/index.ts:13` first.** Its production default is
   `https://stocklabs-backend.onrender.com`, which is *not* where prod actually is
   (`stocklabs-server.onrender.com`). Any EAS build without an explicit env var ships the wrong host
   today.
9. Keep Render running until OTA adoption is high. Installed apps that have not updated still hit the
   old host. Render is also the rollback: DNS back, clients back, no data to unwind because the two
   databases are separate.

### Two accepted consequences

- **Every web user is logged out at cutover.** The session cookie is host-only with no `domain`
  attribute (`userController.ts:61-65`), so cookies issued by the Render host do not carry to
  `api.aryantechie.in`. Users simply log in again.
- **All balances, portfolios, orders and shorts start empty** — the fresh-database decision
  ([ADR 0007](./decisions/0007-fresh-empty-database.md)). Every account is reset to the schema default
  of 100,000,000 (`prisma/schema.prisma:22`) on first signup.

Both are known and accepted. Say so publicly before the switch rather than after.

---

## Post-deploy verification

Locally, before touching the VM:

- `npm test` — the existing Vitest suite (70 cases; Prisma is mocked, no live Redis/Postgres needed).
  It must pass **and the vitest process must exit on its own** — that is the acceptance criterion for
  the `lazyConnect` Redis extraction, since an eagerly-connecting Redis client leaves open handles.
- `npm run build` — clean. Watch the test fixtures missing `Row.tsMs`
  ([gotchas.md](./gotchas.md#no-staleness-guard-on-the-crypto-fill-path)).
- `docker compose -f docker-compose.prod.yml up -d` locally and walk the stack.

On the VM, in order:

| Check | Expected |
|---|---|
| `$COMPOSE ps` | all healthy; `migrate` exited 0 |
| `curl https://api.../healthz`, `/readyz` | 200 from inside the container; **404 from the internet** |
| worker logs | Binance ticks flowing, commodity SSE connected |
| `redis-cli --scan --pattern 'tick:*'` inside the container | ~50 keys, all with TTL > 0 |
| `$COMPOSE up -d --scale api=3` | 3 replicas; Nginx spreads requests across all 3 |
| signup → login → buy → sell | fills at a server-side price; balance updates correctly |
| password reset, repeated, against `api=3` | works **every** time — the real test that OTP moved to Redis |
| Socket.IO board with `api=3` | every client gets ticks regardless of replica, **once** per second |
| commodity SSE with `api=3` | stream stays open; prices update on every replica |
| same account logged in twice | older session disconnected — the Redis-adapter test |
| `$COMPOSE stop api` mid-request | in-flight request completes; no connection reset |
| rolling restart script | no failed requests across a full replica turnover |
| nightly `pg_dump` | file lands in the backup volume, **and restores into a scratch DB** |
| `limit_req` on `/api/v1/forget` | 429 after the configured burst |
| `psql` / `redis-cli` from outside the VM | refused |
