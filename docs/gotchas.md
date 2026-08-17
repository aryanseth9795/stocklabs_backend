# Gotchas

Traps found while designing the migration. Every one of them is either invisible at one replica, or
looks like a working config until it costs a user money. Each entry is **symptom → cause → fix**.

**Status:** these describe hazards in code that exists (`app.ts`, `src/utils/**`) and in code that is
still to be written (Dockerfile, Nginx, shutdown). Where the fix is not yet applied, the entry says so.

---

## Runtime — Socket.IO and the Redis adapter

### The board broadcast must be `io.local.to()`

**Symptom.** After adding the Socket.IO Redis adapter and scaling to N replicas, every client receives
the `board` event N times per second instead of once. Charts jitter, mobile burns battery, and the
bandwidth bill scales quadratically with replica count.

**Cause.** `app.ts:445-452` runs a 1 s interval on **every** replica and calls
`io.to(BOARD_ROOM).emit(...)`. Without the adapter that only reaches locally-connected sockets. *With*
the adapter, `io.to()` is fleet-wide — so N replicas each broadcast the same board to every client on
every replica.

**Fix.** `io.local.to(BOARD_ROOM).emit(...)`. Each replica serves its own room members from its own
Redis-fed `boardCache` — which is exactly the behaviour that works today. The guard above it,
`io.sockets.adapter.rooms.get(BOARD_ROOM)` (`app.ts:447`), stays correct unchanged: the Redis adapter
does not sync the rooms map, so it remains a local check.

**Rule of thumb for the rest:** per-socket emits (`landing`, `portfolio:batch`, `Portfolio_info`,
`error`) already target a socket on the current replica and need no change. The *only* emit that must
go fleet-wide is the single-session disconnect below.

### Single-session disconnect must go the other way — fleet-wide

**Symptom.** A user logs in on a second device; the first session stays connected. The "one session
per account" guarantee holds only when both sessions happen to land on the same replica.

**Cause.** `userSockets` is a local `Map` (`app.ts:455`) and the disconnect at `app.ts:564-565` is
`io.sockets.sockets.get(id)?.disconnect()` — a lookup in this process's socket table only. This is
review finding **D-5** (which also flags that the current delete-vs-set ordering depends on Socket.IO
dispatching `disconnect` synchronously).

**Fix.** Move the map to Redis as `userId → socketId`, and switch the disconnect to the adapter-aware
`io.in(socketId).disconnectSockets()`.

### The Socket.IO adapter needs its own Redis clients

**Symptom.** `[Redis] pmessage parse error` in the logs of every replica, on **every Socket.IO
broadcast anywhere in the fleet**. Prices still work, so it reads like noise — until it buries the log.

**Cause.** In ioredis a subscriber client holds many subscriptions at once. Reusing `rSub`
(`app.ts:52`) for `@socket.io/redis-adapter` means the adapter's own `psubscribe` traffic is also
delivered to our handler at `app.ts:428`, which does `JSON.parse(raw)`. The adapter's payloads are
**msgpack binary**, so the parse throws and the `catch` at `app.ts:436-438` fires.

**Fix.** Give the adapter `rCmd.duplicate()` × 2 (a pub and a sub client of its own), and add a
defensive channel filter at the top of the `pmessage` handler:

```ts
if (!channel.startsWith("tick.")) return;
```

Note this means the handler's currently-unused `_channel` parameter (`app.ts:428`) has to be used.

---

## Shutdown

### `io.disconnectSockets()` during shutdown kills the whole fleet

**Symptom.** A rolling restart of 3 replicas disconnects **every** connected user **three times** —
once per replica restarted — instead of only the users on the replica going down. Looks like a
platform-wide outage during what was supposed to be a zero-downtime deploy.

**Cause.** With the Redis adapter installed, `io.disconnectSockets()` is fleet-wide, exactly like
`io.to()`. The shutdown handler naturally reads as "disconnect my sockets".

**Fix.** `io.local.disconnectSockets(true)`. This is the highest-consequence single-word mistake in
the whole migration — one missing `.local.` turns a graceful drain into a fleet-wide kick.

### SSE responses stop `server.close()` from ever completing

**Symptom.** A container never exits on SIGTERM. It sits there until Docker's `stop_grace_period`
expires and SIGKILLs it — so none of the graceful shutdown ran, and in-flight requests were dropped
anyway. Reproduces only when at least one mobile client is on the commodity screen.

**Cause.** `server.close()` stops accepting new connections and waits for existing ones to finish. An
SSE response **never finishes** — that is the point of it. One attached subscriber
(`commodityFeed.ts:35`, registered at `commodityController.ts:40`) is enough for the callback to never
fire.

**Fix.** In the shutdown sequence, explicitly end every SSE response before waiting on
`server.close()`, and clear each subscriber's 20 s keepalive interval (`commodityController.ts:43`) —
an uncleared timer keeps the event loop alive on its own.

### Every anonymous `setInterval` keeps the process alive

**Symptom.** Same as above, minus the SSE clients: the process refuses to exit and gets SIGKILLed.

**Cause.** Timers are anonymous today and their handles are discarded, so nothing can clear them:
`app.ts:251` (snapshot), `:445` (board), `:457` (online stats), `:584` (landing poll), `:655`
(portfolio poll), `:715` (self-ping), plus `commodityController.ts:43` (SSE keepalive). Separately,
`startAutoCutJob()` (`autoCutJob.ts:119-130`) **discards the `cron.schedule(...)` handle**, so the cron
cannot be stopped either — it must be changed to return it.

**Fix.** Capture every interval in a module-level array, clear them all in the shutdown handler, and
return the cron handle from `startAutoCutJob()`. Back it with a
`setTimeout(() => process.exit(1), 15_000).unref()` watchdog — 15 s sits under the 45 s
`stop_grace_period`, so the process always exits under its own power.

### Closing the listener immediately still drops requests

**Symptom.** "Zero-downtime" deploys produce a handful of 502s, and — worse — a small number of failed
POSTs. One user's order silently fails during every deploy.

**Cause.** On SIGTERM the container's DNS record still exists for up to the resolver's `valid=`
window. If `server.close()` runs immediately, Nginx sends a request into a closed port →
`ECONNREFUSED`. That *is* retried for GETs, but a POST is not retried unless `non_idempotent` is set —
and setting that is its own, worse bug (below).

**Fix.** Flip `/readyz` to 503 first, then **keep serving normally for an ~8 s drain delay** before
`server.close()`. Order for the whole sequence: idempotence guard + watchdog → `/readyz` 503 → drain
→ `server.close()` + `closeIdleConnections()` → `io.local.disconnectSockets(true)` → end SSE
responses → stop cron and clear intervals → close upstream WS/SSE → `prisma.$disconnect()` →
`rCmd.quit()` / `rSub.quit()` → exit.

### `uncaughtException` currently keeps a corrupt process alive

**Symptom.** A replica stays in the load balancer serving errors after an unrecoverable fault.
`restart: unless-stopped` never helps, because the container never exits.

**Cause.** `app.ts:726-728` logs and returns.

**Fix.** Run the shutdown sequence and `process.exit(1)`. Leave `unhandledRejection`
(`app.ts:722-724`) as log-and-continue — this codebase has un-awaited promises in several places and
exiting on those would be a stability *regression*.

---

## Pricing correctness

### Hydrating through `setCommodityPrice()` resurrects stale prices

**Symptom.** Immediately after a replica restarts, commodity orders fill at prices up to ~90 seconds
old. Only that replica, only for the first minute, and only after a restart — so it is nearly
impossible to catch in the act.

**Cause.** `setCommodityPrice()` stamps `commodityUpdatedAt[symbol] = Date.now()`
(`priceCache.ts:38-42`). A cold replica hydrating an 85-second-old value from Redis through that
function resets the freshness clock to *now*; the 60 s guard at `priceCache.ts:60-61` then passes and
the next order fills against an 85-second-old price — reintroducing exactly the stale-fill bug the
guard exists to prevent.

**Fix.** Add `setCommodityPriceAt(symbol, price, tsMs)` that stores the **source** timestamp, and use
it on **both** the hydration and the live paths. Keep `setCommodityPrice` as a thin wrapper so
existing tests keep their signature.

### The staleness check is skipped when there is no timestamp

**Symptom.** None today. It becomes live the moment Redis hydration exists.

**Cause.** `priceCache.ts:60-61`:

```ts
const updatedAt = commodityUpdatedAt[key];
if (updatedAt && Date.now() - updatedAt > MAX_PRICE_AGE_MS) return null;
```

A falsy `updatedAt` skips the staleness check **entirely** and the price is returned as fresh. Redis
hydration is precisely the path that can produce a price with no timestamp.

**Fix.** `if (!updatedAt || Date.now() - updatedAt > MAX_PRICE_AGE_MS) return null;` — no timestamp
means no provenance means no fill.

### No staleness guard on the crypto fill path

**Symptom.** A replica whose `tick.*` subscription has gone quiet keeps filling crypto orders at a
frozen price, forever. Commodities correctly refuse; crypto does not.

**Cause.** `getLivePriceINR()` checks age for commodities (`priceCache.ts:60-61`) but the crypto branch
(`priceCache.ts:66-71`) only checks that the number is finite and positive. There is no age comparison
at all.

**Fix.** Apply the same `MAX_PRICE_AGE_MS` comparison against `row.tsMs` — the field is already
stamped in `normaliseTicker()` (`app.ts:287`). This matters far more after the split: a single sick
process was obvious; one sick replica out of four is not.

**Knock-on.** `tests/executeOrder.test.ts:17-28`, `tests/priceCache.test.ts:12-23` and
`tests/shortPosition.test.ts:19-30` build a `Row` without `tsMs`. They compile today only because
`tsconfig` excludes `tests/` — the moment the guard reads `row.tsMs`, roughly half the suite fails with
"No live price available". Fix the fixtures in the same commit as the guard.

### The worker must subscribe to its own publishes

**Symptom.** Every crypto short is silently skipped by the midnight auto-cut. The log shows
`[AutoCut] No price found for BTCUSDT, skipping.` for every position, and users wake up still holding
shorts that should have been cut.

**Cause.** The worker *writes* ticks to Redis (`app.ts:370-377`), but `boardCache` is filled **only**
by the `pmessage` handler (`app.ts:427-439`). `autoCutJob.ts:28` calls `getLivePriceINR()`, which reads
`boardCache` (`priceCache.ts:66`). A worker that skips the subscription because "it is the producer"
has a permanently empty board, and `autoCutJob.ts:33-38` logs and `continue`s.

**Fix.** The worker subscribes to `tick.*` too. It costs one subscription and keeps exactly one writer
of `boardCache` in the codebase, identical in both roles. Do not special-case it.

---

## Build and image

### `prisma` as a devDependency breaks `npm ci --omit=dev`

**Symptom.** The runtime stage of the Docker build fails on `postinstall`, or produces an image where
`prisma migrate deploy` cannot run.

**Cause.** `package.json` has `"postinstall": "prisma generate"`, which still runs under
`npm ci --omit=dev` — but with `prisma` in `devDependencies` the binary is not installed. The one-shot
`migrate` compose service has the same problem: no CLI in the image.

**Fix.** Move `prisma` to `dependencies` (~15 MB, both problems gone). **Already applied** — see
`package.json` `dependencies`.

### `COPY prisma` must precede `npm ci`

**Symptom.** `npm ci` fails in the builder stage with a Prisma error about a missing schema.

**Cause.** The same `postinstall: prisma generate` hook needs `prisma/schema.prisma` to exist at
install time. The instinctive Dockerfile — `COPY package*.json` → `npm ci` → `COPY .` — does not have
it yet.

**Fix.** `COPY package*.json prisma/ ./` (schema included) **before** `npm ci`, then copy the rest of
the sources.

### Shell-form `CMD` breaks SIGTERM

**Symptom.** No graceful shutdown ever runs. Every `docker compose stop`, scale-down and rolling
restart hard-kills the container after the grace period. All the shutdown work above is dead code.

**Cause.** Shell-form `CMD node dist/app.js` puts `/bin/sh` at PID 1, and it does not forward SIGTERM
to its child.

**Fix.** Exec form: `CMD ["node", "dist/app.js"]`, plus `init: true` in compose (or `--init`) and
`stop_grace_period: 45s`.

### `cors` was imported but not declared

**Symptom.** A build or runtime that installs dependencies strictly (or a future npm that stops
hoisting) fails with `Cannot find module 'cors'` — from a file that has worked for a year.

**Cause.** `app.ts:17` imports `cors`, which resolved only because `socket.io` depends on it and npm
flattens `node_modules`.

**Fix.** Declare `cors` and `@types/cors` explicitly. **Already applied** — see `package.json`.

### `generated/` must never enter the image

**Symptom.** A ~22 MB image bloat, and — if anything ever loads it — a Linux container trying to
`dlopen` a Windows binary.

**Cause.** `Server/generated/` is a dead artifact from an old Prisma `output` setting (now commented
out at `prisma/schema.prisma:9`) containing `query_engine-windows.dll.node`.

**Fix.** `.dockerignore` must list `node_modules`, `dist`, `generated`, `.env*`, `.git`, `tests`,
`*.md`. Also note the checked-in `dist/` is stale — it contains orphaned output
(`dist/scripts/clearData.js`) whose source no longer exists — so `dist/` must be built fresh inside the
image, never copied from the host.

---

## Nginx

### `proxy_next_upstream non_idempotent` duplicates trades

**Symptom.** A user is debited twice for one order, or holds two positions after clicking Buy once.
Rare, correlated with deploys, and effectively unexplainable from the application logs — the app saw
two legitimate requests.

**Cause.** Every zero-downtime Nginx tutorial recommends
`proxy_next_upstream error timeout non_idempotent`. `non_idempotent` tells Nginx it may retry
**POSTs** on another upstream. On a trading API, a request that timed out *after* being processed gets
replayed: a duplicate order and a duplicate balance debit.

**Fix.** `proxy_next_upstream error timeout http_502 http_504` — and **neither `non_idempotent` nor
`http_503`**. `http_503` is wrong for a separate reason: the 503s in this codebase are the
application's *business* 503 ("No live price available", `commodityController.ts:92`,
`shortController.ts:39-41`), and the price feed is shared through Redis, so a peer returns the same
answer. Retrying it is useless and it masks a real outage. Cold replicas are handled at the app layer
instead — gate `server.listen()` on hydration so "in DNS but not ready" collapses to `ECONNREFUSED`,
which *is* in `proxy_next_upstream error` and gets transparently retried onto a warm peer.

### A static `upstream` block never sees new replicas

**Symptom.** `--scale api=4` reports four containers, but all traffic keeps going to one of them. Or
Nginx **refuses to start at all** after a scale-down.

**Cause.** Open-source Nginx resolves names in an `upstream` block **once at config load** and caches
the IP forever (`server ... resolve` is NGINX Plus only). And if any name in an `upstream` block fails
to resolve at load time, Nginx exits rather than starting degraded — so pre-declaring `api-1..api-4`
means you must always run exactly four.

**Fix.** `resolver 127.0.0.11 valid=…` plus a variable `proxy_pass`. Tradeoffs are documented in
[ADR 0005](./decisions/0005-nginx-dns-resolver-load-balancing.md).

### A variable in `proxy_pass` silently disables URI rewriting

**Symptom.** Every path 404s, or requests arrive at the app with a mangled path.

**Cause.** When `proxy_pass` contains a variable, Nginx does **not** apply the location's URI
substitution. A trailing slash or any path component in the target then rewrites every request path.

**Fix.** Define the target with no path component:

```nginx
set $api_backend "api:4000";
proxy_pass http://$api_backend;
```

### `limit_req` on `/socket.io/` turns a restart into an outage

**Symptom.** After any deploy, clients reconnect-loop for minutes and the platform looks down for far
longer than the restart took.

**Cause.** A restart causes a *synchronised* reconnect storm — every client at once, by definition.
Rate-limiting that path throttles exactly the traffic you need to recover.

**Fix.** No `limit_req` on `/socket.io/`. Apply it where it is actually needed: `/api/v1/login`,
`/api/v1/signup`, and especially `/api/v1/forget`.

---

## Operations and observability

### `logTop50FromRedis` cries "feed is DOWN" on every api replica

**Symptom.** Every 60 seconds, on every api replica, forever:

> `[Board] NO upstream ticks in the last interval — the price feed is DOWN. Clients are being served
> an empty board and trades will be refused with 503.`

…while the feed is perfectly healthy and trades are filling normally.

**Cause.** `upstreamMsgCount` (`app.ts:159`) is incremented **only** on the ingest path
(`app.ts:368`), which after the split runs on the worker alone. On an api replica the delta is
permanently 0, so the `console.error` at `app.ts:236-241` always fires.

**Fix.** Make the 60 s snapshot logger **worker-only**. This is not cosmetic: a permanent false alarm
trains you to ignore the one log line that actually matters. Api replicas get their board-health
signal from `/readyz` instead.

### `/readyz` that gates on the price feed takes the whole fleet down

**Symptom.** Binance has an outage; every replica reports unready; Nginx has no upstream at all; the
entire site 502s — including login, portfolio views, and everything that has nothing to do with
prices.

**Cause.** Gating readiness on a condition that is shared by all replicas.

**Fix.** One rule: **`/readyz` may only fail on conditions that make *this* replica worse than its
peers.** A shared condition is *reported*, never *gated*. Details and the api-vs-worker inversion are
in [runbook.md](./runbook.md#reading-readyz).

### A container with no `REDIS_URL` boots happily and does nothing

**Symptom.** A replica that starts, answers `/ping`, serves an empty board forever, and logs Redis
connection errors on a loop. `/ping` (`app.ts:116-118`) touches nothing, so a naive healthcheck calls
it healthy.

**Cause.** `REDIS_URL` is optional with a `redis://127.0.0.1:6379` fallback (`src/config/env.ts`).
Inside a container, `127.0.0.1` is that container's own empty network namespace.

**Fix.** Make `REDIS_URL` required when `NODE_ENV=production`, and use `/healthz` + `/readyz` for
health checks rather than `/ping` (kept only for backwards compatibility).

### A typo'd `ROLE` must throw, not default

**Symptom.** `ROLE=Api ` (stray capital, trailing space) in a compose file silently gives you the
old monolith in every replica — N Binance connections, N crons — the exact failure the split exists
to prevent.

**Cause.** The obvious implementation, `optional("ROLE", "all")`, treats any unrecognised value as the
default.

**Fix.** Optional with default `"all"` (so tests, `npm run dev` and Render keep working with zero env
changes), but **strict** on an unrecognised value. Already implemented in `src/config/env.ts` — the
`role()` helper throws with the list of valid values.

### `NODE_ENV=production` requires TLS to actually be terminating

**Symptom.** Nobody can log in on the web. Cookies are set by the server and dropped by the browser.

**Cause.** `NODE_ENV=production` flips the session cookie to `secure: true, sameSite: "none"`
(`userController.ts:64-65`). Those cookies are only accepted over HTTPS.

**Fix.** Never run the production env file without TLS in front of it — not even for a quick local
smoke test of the compose stack. Use `NODE_ENV=development` locally.
