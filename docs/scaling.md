# Scaling

**Status: planned.** Nothing here is live until the container stack lands. The `ROLE` env contract
(`src/config/env.ts`) is in the tree; the role split inside `app.ts` and the Redis-backed shared state
are not, so **scaling `api` past 1 today would still break** — the checklist at the bottom is the list
of what must be true first.

## How to scale

```bash
docker compose -f docker-compose.prod.yml up -d --scale api=4
```

That is the whole operation. Nginx discovers the new replicas through Docker's embedded DNS
(`resolver 127.0.0.11 valid=…` + variable `proxy_pass`), so no config edit and no reload are needed —
new replicas take traffic within the resolver TTL. See
[ADR 0005](./decisions/0005-nginx-dns-resolver-load-balancing.md).

Two compose details make `--scale` work at all, and both are easy to undo by accident:

- the `api` service must have **no `container_name`** (a fixed name means only one container can exist)
- the `api` service must have **no published `ports:`** (a host port cannot be bound by N containers)

Only `nginx` binds host ports. `postgres` and `redis` publish nothing at all.

## `worker` stays at exactly 1

Not a recommendation. `worker` owns everything that must happen **once**, and there is no coordination
— no leader election, no distributed lock, no advisory lock in Postgres. One replica *is* the
mechanism.

| Scale `worker` to N and this breaks | Why |
|---|---|
| **Binance ingest** | N WebSocket connections to `wss://stream.binance.com:9443` from one VM IP (`app.ts:420`). Binance rate-limits connections per IP; the reconnect backoff at `app.ts:402-418` exists precisely because a sustained outage must not hammer them. Review **S-15** was this same problem from a different direction — leaked duplicate sockets after a reconnect. |
| **Redis pub/sub** | N× writes and N× publishes of every tick (`app.ts:370-377`), each delivered to all N subscribers — **N² amplification** of a stream that already runs at several messages per second across 50 symbols. |
| **Commodity feed** | N persistent upstream SSE connections to a third-party free-tier service (`commodityFeed.ts:121-184`). It flaps under normal conditions; N clients make that worse and are visibly rude. |
| **Midnight auto-cut** | `node-cron` fires on every replica (`autoCutJob.ts:124`). The double-credit itself is guarded — the conditional claim at `autoCutJob.ts:49-63` means only one process can close a position — but **every** replica still scans **every** open short, and each computes its own `exitPrice` from its own `boardCache`, so which replica wins decides what price a user was cut at. Same job, N different answers. |
| **Snapshot logger** | N× `MGET` of all 50 keys every 60 s (`app.ts:210-242`) and N copies of the same table in the logs. |

If the worker ever *must* be made highly available, the honest answer is a Redis lock or a Postgres
advisory lock around each of those four jobs — not "just scale it". Until that exists, the constraint
is absolute.

## What had to move to Redis for `api` to be replica-safe

Each row is a thing that is per-process today and would silently misbehave at N replicas.

| State | Today | After | Why it cannot stay local |
|---|---|---|---|
| Crypto prices | `boardCache` filled by this process's own upstream | worker writes, every replica `psubscribe`s (`app.ts:427-439`) | An api replica holds no upstream connection, so it would have an empty board — and `getLivePriceINR()` reads `boardCache` (`priceCache.ts:66`), so every crypto order would 503. |
| Commodity prices | `commodityPriceCache`, process-local, never written to Redis (`priceCache.ts:24`) | `SET commodity:<SYM> … EX 90` + `PUBLISH commodity.sse`, consumed by all roles | Same failure for commodities: `commodityController.ts:88-93` returns 503 with no price. |
| OTP records | in-process `Map` (`userController.ts:39`) | Redis keys with native TTL | Review **D-3**. Reset fails ~(N−1)/N of the time; the 60 s resend cooldown (`userController.ts:465`) is bypassable by hitting a different replica; and `OTP_MAX_ATTEMPTS = 5` (`userController.ts:42`, `:532`) becomes an effective 5×N guesses. |
| Socket registry | `userSockets` Map (`app.ts:455`, `:564-566`) | `userId → socketId` in Redis + `@socket.io/redis-adapter` | Review **D-5**. Single-session enforcement is local-only, so the same account stays connected on two replicas — the "log in elsewhere, get kicked" guarantee quietly stops holding. |
| Socket.IO broadcast | in-process adapter | Redis adapter | Without it, `io.in(socketId).disconnectSockets()` cannot reach a socket living on another replica. |
| Postgres connections | Prisma default pool = `cpus*2+1` **per process**, no cap (`src/db/db.ts`) | explicit `?connection_limit=N&pool_timeout=…` on `DATABASE_URL` | The pool is per-process, so the fleet total is `replicas × limit`. On a 4-vCPU VM that is 9 connections per replica by default — 5 replicas is 45, plus the worker, against a stock `max_connections` of 100. Set it so `(api_replicas + 1) × limit` stays comfortably under the container's `max_connections`, with headroom for `psql` and the backup job. |

## What is deliberately still per-process

Not oversights. Both are correct as local state and would be wrong to share.

| Local state | Where | Why local is right |
|---|---|---|
| SSE subscriber set | `subscribers: Set<Response>` (`commodityFeed.ts:35`), fanned out by `broadcast()` (`:95-103`) | An Express `Response` is a live socket handle; it cannot cross a process boundary. Each SSE client is pinned to the replica that accepted its connection, by construction. Only the *source* of the data moves to Redis. |
| Per-socket pollers | `landingPoll` (`app.ts:584-590`), `portfolioPoll` (`app.ts:655-663`) | They emit to one socket that is connected to this replica. Cleared on `disconnect` (`app.ts:678-698`) and, after the shutdown work, on SIGTERM. |
| `boardCache` itself | `priceCache.ts:21` | Every replica keeps its own copy, fed from the same Redis stream. That is why the 1 s broadcast must be `io.local.to(...)` — each replica serves its own room members from its own copy. Using `io.to(...)` would deliver the board N times per second to every client; see [gotchas.md](./gotchas.md#the-board-broadcast-must-be-iolocalto). |
| `guestSockets` | `app.ts:456` | Diagnostics only (the 60 s online-count table). Per-replica counts are fine; nothing depends on the total. |

## Before you scale — checklist

Every item must be true, or `--scale api=2` is silently wrong rather than loudly broken.

1. `ROLE` is set per service in compose (`api` / `worker`) — never left to default `all`, which would
   put a Binance ingester and the cron into every replica.
2. `worker` is at exactly 1 replica and is **not** in the Nginx upstream.
3. The api role does not start `startAutoCutJob()`, the commodity upstream, `connectBinanceUpstream()`,
   or `logTop50FromRedis()`.
4. The board broadcast uses `io.local.to(BOARD_ROOM)` (`app.ts:451`).
5. The Socket.IO Redis adapter has **its own** Redis client pair — not `rSub`
   ([gotchas.md](./gotchas.md#the-socketio-adapter-needs-its-own-redis-clients)).
6. OTP records and the `userId → socketId` map are in Redis.
7. Commodity prices are written to and read from Redis, and cold replicas hydrate via
   `setCommodityPriceAt` — **not** `setCommodityPrice`
   ([gotchas.md](./gotchas.md#hydrating-through-setcommodityprice-resurrects-stale-prices)).
8. `DATABASE_URL` carries `connection_limit`, and `(api_replicas + 1) × limit` fits under
   `max_connections`.
9. `server.listen()` is gated on board hydration, so a cold replica is `ECONNREFUSED` (retried by
   `proxy_next_upstream error`) rather than in DNS and answering 503s (not retried, by design).
10. SIGTERM handling is in place and `CMD` is exec-form, or every scale-down drops in-flight requests
    and sockets.

Verify with the matrix in [runbook.md](./runbook.md#post-deploy-verification) — in particular the
password-reset-against-a-scaled-stack check, which is the only real test that the OTP store actually
moved.
