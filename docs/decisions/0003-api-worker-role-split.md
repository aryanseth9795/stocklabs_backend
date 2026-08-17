# 0003 — Split the process into `api` (N replicas) and `worker` (exactly 1)

**Status:** accepted, 2026-08-17

## Context

`app.ts` was one process doing six jobs at once: the REST API, the Socket.IO server, the Binance
market-data ingester, the commodity SSE ingester, the midnight cron scheduler, and the in-memory
price authority that decides what price every order fills at. All six started unconditionally at
module scope.

The requirement was to scale the Node tier on demand. Containerizing that process unchanged and
running two of it would have produced, silently:

| Consequence | Cause |
|---|---|
| Binance rate-limits the VM | N WebSocket connections from one IP |
| N² Redis traffic | N publishers of identical ticks, each consumed by all N subscribers |
| Third-party feed sees N clients | N persistent commodity SSE connections |
| Midnight cron fires N times | `node-cron` scheduled per process |
| Password reset fails ~(N−1)/N | OTP store was an in-process `Map` |
| OTP brute-force cap becomes 5×N | same |
| Duplicate sessions per user | `userSockets` registry was per process |
| Commodity orders 503 on some replicas | `commodityPriceCache` was per process, never in Redis |

None of these fail loudly. Several corrupt money.

## Decision

Two roles, selected at runtime.

- **`worker`** — exactly one replica, always. Owns the Binance upstream, the commodity upstream, and
  the midnight auto-cut cron. Publishes everything it learns to Redis. Runs Express only so it has a
  health endpoint; the API routers are not mounted on it.
- **`api`** — N replicas. Express, Socket.IO, and a pure Redis *consumer*. Starts no ingester and no
  cron.

Nginx routes public traffic only to `api`.

## Consequences

- **`--scale api=N` becomes genuinely safe**, which was the point.
- **The worker also subscribes to `tick.*`.** Non-obvious but required: it publishes ticks yet never
  writes `boardCache` — only the subscription handler does — and the midnight auto-cut reads
  `boardCache` through `getLivePriceINR`. A worker that skipped this would silently skip every crypto
  short at 00:00 IST. Consuming its own publishes also keeps exactly one cache-writing path in the
  codebase, identical in both roles.
- **The 60 s snapshot logger is worker-only.** `upstreamMsgCount` only increments on the ingest path,
  so on an `api` replica the delta is permanently zero and the "price feed is DOWN" alarm would fire
  every minute forever while the feed was healthy — training the operator to ignore the one log line
  that matters.
- **The worker is a single point of failure for prices.** If it dies, ticks stop, Redis keys expire
  after 120 s, and trades correctly begin refusing with 503. Its `/readyz` gates on the Binance socket
  being open *and* having delivered a tick in the last 30 s, because "connected" and "receiving data"
  are not the same thing — the geo-blocked futures endpoint held an open socket and sent nothing.
- Several pieces of state had to move to Redis for this to work; see
  [scaling.md](../scaling.md) and [0004](./0004-one-image-role-env-var.md).
