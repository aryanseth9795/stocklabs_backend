# Architecture

**Status: planned.** The `ROLE` env plumbing (`src/config/env.ts`) and the dependency fixes in
`package.json` are in the tree as of 2026-08-17; the role split inside `app.ts`, the container stack,
and Nginx are not. Line numbers below refer to `app.ts` as it stands today (pre-split) — that is
deliberate, because the point is to show *where* each piece moves from.

## What the system is

A paper-trading backend. Users hold a play balance (`prisma/schema.prisma:22`, default 100,000,000)
and trade crypto and commodities at **server-decided prices**. No real orders are ever placed
anywhere; the upstream feeds are price sources only.

Three surfaces, all served by the same Node process today:

| Surface | Entry point | Used by |
|---|---|---|
| REST | `app.ts:120-122` — `/api/v1/` (user), `/api/v1/short`, `/api/v1/commodity` | Web + mobile |
| Socket.IO | `app.ts:135-143`, handlers at `app.ts:560-699` | Web + mobile — board, landing, portfolio |
| SSE | `GET /api/v1/commodity/stream` (`src/controllers/commodityController.ts:37-43`) | Mobile commodity screen |

Persistence is Postgres through Prisma (`src/db/db.ts`, schema in `prisma/schema.prisma`: `User`,
`Portfolio`, `Transaction`, `Order`, `ShortPosition`, `CommodityPortfolio`). Redis is cache, pub/sub
and — after this migration — shared state.

The rule that everything else defends: a trade fills at `getLivePriceINR()`
(`src/utils/priceCache.ts:49-72`) or it does not fill at all. `null` means HTTP 503, never "use the
price the client sent" (`commodityController.ts:92`, `shortController.ts:39-41`). That is review
finding S-02, and it is why the price path is treated as correctness-critical rather than as a
nice-to-have feed.

## Why the deployment changed

Before: Render (plain Node runtime) + Neon (managed Postgres) + Render Key Value (managed Redis).
After: one VM, Docker Compose, Postgres and Redis as internal containers, Nginx terminating TLS, and
the Node tier able to run N replicas. See [ADR 0001](./decisions/0001-single-vm-docker-compose.md)
and [ADR 0002](./decisions/0002-internal-postgres-and-redis.md).

The finding that shaped the design: **`app.ts` is a single process that is simultaneously** the REST
API, the Socket.IO server, the Binance ingester, the commodity SSE ingester, the midnight cron, and
the in-memory price authority. All of it starts unconditionally at module scope:

| Started at module scope | Line |
|---|---|
| `startAutoCutJob()` — midnight cron | `app.ts:151` |
| `startCommodityFeed()` — upstream SSE | `app.ts:156` |
| `hydrateBoardFromRedis()` + 60 s snapshot logger | `app.ts:246-252` |
| `connectBinanceUpstream()` — upstream WS | `app.ts:420` |
| `server.listen()` | `app.ts:732` |

Containerising that as-is and running two replicas does not scale it — it breaks it. The full
breakage table is in [scaling.md](./scaling.md). So the migration does the containerisation *and* the
scale-safety work together.

## Topology

```
                        internet :443
                             │
                        [ nginx ]  TLS (Let's Encrypt), rate limiting,
                             │      WS upgrade, SSE passthrough
                ┌────────────┴────────────┐
                │                         │
          [ api × N ]                [ worker × 1 ]
     Express + Socket.IO          Binance WS → Redis
     Redis subscriber only        Commodity SSE → Redis
     serves SSE from its          midnight auto-cut cron
     own Redis-fed cache          no public traffic
                └────────────┬────────────┘
                             │
                  [ redis ]      [ postgres ]
              cache + pub/sub    named volume, nightly pg_dump
              + OTP + io-adapter
                     internal network only
                     no published host ports
```

One image, two roles, selected by `ROLE` ([ADR 0004](./decisions/0004-one-image-role-env-var.md)).
Nginx is the only service that binds host ports. Only `api` is in the Nginx upstream — the worker
listens (for its health endpoint) but receives no public traffic.

## The role split

`ROLE` is validated in `src/config/env.ts`: `api` | `worker` | `all`, defaulting to `all`, and
**throwing** on any other value. `all` is byte-for-byte today's behaviour, which is what makes the
refactor a provable no-op in dev and on Render. Full reasoning in
[ADR 0003](./decisions/0003-api-worker-role-split.md).

| Job | Role | Call site today |
|---|---|---|
| Binance upstream WS ingest | worker | `app.ts:420` |
| Commodity SSE upstream ingest | worker | `app.ts:156` → `commodityFeed.ts:187-192` |
| Midnight auto-cut cron | worker | `app.ts:151` → `autoCutJob.ts:119-130` |
| Top-50 snapshot logger (60 s) | worker | `app.ts:251` |
| Express routers | api | `app.ts:120-122` |
| Socket.IO server + per-socket pollers | api | `app.ts:135`, `:560-699` |
| `psubscribe("tick.*")` → `boardCache` | **both** | `app.ts:427-439` |
| Boot hydration from Redis | both | `app.ts:174-207` |
| 1 s board broadcast | api | `app.ts:445-452` |

Two entries in that table are counter-intuitive and are explained where they bite, in
[gotchas.md](./gotchas.md):

- **The worker subscribes to its own publishes.** It writes ticks to Redis (`app.ts:370-377`) but only
  the `pmessage` handler fills `boardCache` — and `autoCutJob.ts:28` calls `getLivePriceINR()`, which
  reads `boardCache` (`priceCache.ts:66`). A worker that does not subscribe has an empty board and the
  midnight auto-cut silently skips every crypto short (`autoCutJob.ts:33-38`).
- **The 60 s snapshot logger is worker-only**, because on an API replica its `upstreamMsgCount` delta
  (`app.ts:159`, incremented only at `:368`) is permanently 0 and the "price feed is DOWN"
  `console.error` at `app.ts:236-241` would fire forever on a healthy fleet.

## Data flow — crypto

```
Binance spot combined stream (wss://stream.binance.com:9443)
   │  @ticker, ~50 symbols, several msgs/sec
   ▼
worker  app.ts:358-381
   normaliseTicker()  app.ts:274-289   USD → INR (usdToInr), tsMs stamped
   pipeline:
     SET  tick:<symbol>  <json>  EX 120      app.ts:375   (TICK_TTL_SECONDS, app.ts:79)
     PUBLISH tick.<symbol> <json>            app.ts:376
   ▼
redis
   ▼
every api replica (and the worker)  app.ts:427-439
   psubscribe "tick.*" → JSON.parse → boardCache[SYMBOL] = row  (priceCache.ts:21)
   boardDirty = true
   ▼
api, once per second, per replica  app.ts:445-452
   if room "top50" non-empty → io.local.to(BOARD_ROOM).emit("board", snapshot)
   ▼
clients that sent "board:subscribe"  (app.ts:602-605)
```

Two consumers of `boardCache`, and they matter differently:

- **Display** — `boardSnapshot()` (`priceCache.ts:75-82`) feeds the `board` broadcast, the `landing`
  poller (`app.ts:584-590`) and `portfolio:batch` (`app.ts:655-663`).
- **Money** — `getLivePriceINR()` (`priceCache.ts:66-71`) reads the same cache to decide the fill
  price of every crypto order and every short close, including the midnight auto-cut.

A replica whose tick subscription dies therefore does not just show stale numbers, it *fills orders*
at stale numbers. Hence two defences: `/readyz` gates on `rSub.status === "ready"` (a per-replica
failure), and the crypto fill path gains the `MAX_PRICE_AGE_MS` staleness check it does not have today
(see [gotchas.md](./gotchas.md#no-staleness-guard-on-the-crypto-fill-path)).

Why keys carry a TTL: presence of a key is itself the freshness proof, which is what makes boot-time
hydration safe (`app.ts:70-79`, `:174-207`). Legacy keys with TTL `-1` are deliberately skipped.
Reader and writer both build the key through `tickKey()` (`priceCache.ts:86-88`) — they used to
derive it independently and disagreed, which is review finding **S-14**.

## Data flow — commodities

Today `commodityPriceCache` (`priceCache.ts:24`) is filled only as a side effect of the upstream SSE
connection held by that same process (`commodityFeed.ts:77-93`), and is **never written to Redis**. An
api replica with no upstream connection would therefore know no commodity prices and 503 every
commodity order (`commodityController.ts:88-93`). The migration mirrors the crypto pattern:

```
third-party SSE  (https://ssj-server-om8r.onrender.com/api/prices/stream)
   │
   ▼
worker   startCommodityUpstream()   — split out of commodityFeed.ts:187-192
   SseParser reassembles chunk-straddling frames   commodityFeed.ts:51-75
   PUBLISH commodity.sse {"event","data","tsMs"}   ← the complete event, VERBATIM
   SET commodity:<SYM> {"price","tsMs"} EX 90      ← per symbol
   ▼
redis
   ▼
api + worker   startCommodityConsumer()
   setCommodityPriceAt(symbol, price, tsMs)   → commodityPriceCache (priceCache.ts:24)
   broadcast(text) → subscribers Set<Response>   commodityFeed.ts:35, :95-103
   ▼
SSE clients attached to THIS replica   commodityController.ts:37-43
```

Three details that are decisions, not incidentals:

- **The worker republishes the raw SSE event, not a reconstruction.** `handleEvent`
  (`commodityFeed.ts:77-93`) extracts only `symbol` + `lastPrice`; republishing that shape would
  silently strip every other field from the mobile client's stream.
- **TTL 90 s vs `MAX_PRICE_AGE_MS` 60 s** (`priceCache.ts:34`) — they answer different questions. The
  TTL is coarse provenance ("was this written by a live feed"), the age check is the fill decision. A
  TTL shorter than the age limit would delete a key whose value is still legally fillable.
- **The worker consumes commodity prices too**, because commodity shorts exist and the auto-cut reads
  them (`autoCutJob.ts:28-31` with `assetType`).

`commodityController.ts` needs no changes — only the *source* of `broadcast()` moves. The
`subscribers` set stays per-replica by necessity: an Express `Response` handle cannot cross a process
boundary.

## Where the data lives

**Postgres** — `postgres:16-alpine`, named volume, no published ports, reachable only on the compose
network. Schema is applied by a one-shot `migrate` service running `prisma migrate deploy` before
`api` and `worker` start. Nightly `pg_dump` to a host-mounted volume with rotation. Prisma's pool is
`cpus*2+1` **per process**, so `DATABASE_URL` carries an explicit `?connection_limit=…&pool_timeout=…`
— without it, N replicas exhaust `max_connections` (see [scaling.md](./scaling.md)).

**Redis** — `redis:7-alpine`, `--appendonly yes`, named volume, no published ports. After the
migration it holds four distinct things:

| Keys / channels | Purpose | Owner |
|---|---|---|
| `tick:<symbol>` (`EX 120`), `tick.<symbol>` channel | crypto prices — snapshot + fan-out | worker writes, everyone reads |
| `commodity:<SYM>` (`EX 90`), `commodity.sse` channel | commodity prices + verbatim SSE relay | worker writes, everyone reads |
| OTP records with native TTL | password reset (review **D-3**) | api |
| Socket.IO adapter channels + `userId → socketId` | cross-replica broadcast and single-session enforcement (review **D-5**) | api |

`REDIS_URL` is plain `redis://redis:6379` — TLS is pointless on a private compose network. It also
flips from optional-with-localhost-fallback (`env.ts` `REDIS_URL`) to **required when
`NODE_ENV=production`**: a container with no `REDIS_URL` silently dials `127.0.0.1:6379` inside its own
network namespace and logs connection errors forever instead of failing to boot.

## What Nginx does

The only container binding host ports (80/443). It handles:

- **TLS termination** — Let's Encrypt via a webroot challenge served by the `certbot` service. Note
  that `NODE_ENV=production` flips session cookies to `secure: true, sameSite: "none"`
  (`userController.ts:64-65`), so TLS terminating in front is a hard requirement, not a nicety.
- **Load balancing to `api`** by DNS re-resolution: `resolver 127.0.0.11 valid=…` plus a variable
  `proxy_pass`, so `--scale api=N` needs no config change. The tradeoffs — no `least_conn`, no
  passive health checks, no upstream keepalive, and a deregistration window — are stated honestly in
  [ADR 0005](./decisions/0005-nginx-dns-resolver-load-balancing.md).
- **WebSocket upgrade** on `/socket.io/` with long idle timeouts, and deliberately **no `limit_req`**
  there — a deploy causes a synchronised reconnect storm and throttling it turns one restart into a
  self-inflicted outage.
- **SSE passthrough** for `GET /api/v1/commodity/stream`: `proxy_buffering off` and a long or disabled
  `proxy_read_timeout`. The app already sets `X-Accel-Buffering: no` (`commodityController.ts:37`) but
  the proxy has to cooperate.
- **Rate limiting** (`limit_req`) on `/api/v1/login`, `/api/v1/signup` and especially `/api/v1/forget`
  — an unauthenticated, email-sending route whose only throttle today is a per-process cooldown
  (`userController.ts:465`). This is review finding D-2, addressed at the edge.
- **Retry policy**: `proxy_next_upstream error timeout http_502 http_504` — with neither
  `non_idempotent` nor `http_503`. Both exclusions are load-bearing; see
  [gotchas.md](./gotchas.md#proxy_next_upstream-non_idempotent-duplicates-trades).
- **Hiding the health endpoints**: `/healthz` and `/readyz` return 404 publicly. `/readyz` runs a DB
  probe, so exposing it is an unauthenticated database-liveness oracle. Docker's healthcheck hits the
  container directly instead.
- `app.set("trust proxy", 1)` on the app side, so `req.ip` is the client and not the proxy.

## What scales and what does not

| Component | Scales? | Why |
|---|---|---|
| `nginx` | 1 (fixed) | Owns 80/443 on the host. Not a bottleneck at this size. |
| `api` | **Yes, N** | Stateless after the Step-3 work: no upstream feeds, no cron, shared state in Redis. `docker compose up -d --scale api=N`. |
| `worker` | **No — exactly 1** | Owns the single Binance connection, the single commodity connection, and the once-a-day cron. Scaling it reintroduces every failure in [scaling.md](./scaling.md). |
| `postgres` | 1 | Single primary, named volume. No replication in this design. |
| `redis` | 1 | Single instance, AOF persistence. Cache + pub/sub + shared state. |
| `migrate` | one-shot | `restart: "no"`, gated on `postgres: service_healthy`; `worker` and `api` wait for it to complete successfully. |

Two things do **not** become shared state by design, and both are correct:

- **SSE `Response` handles** (`commodityFeed.ts:35`) — cannot cross processes; each SSE client is
  pinned to one replica by construction.
- **Per-socket pollers** (`app.ts:584`, `:655`) — they emit to a socket that lives on this replica.

The whole design rests on one constraint: **`worker` stays at 1**. That is the load-bearing part.
