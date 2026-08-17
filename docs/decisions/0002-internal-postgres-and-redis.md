# 0002 — Postgres and Redis as internal containers

**Status:** accepted, 2026-08-17

## Context

Production used Neon (serverless Postgres, us-east-1, pooler endpoint) and Render Key Value
(`rediss://`, Oregon). Both are managed, both are outside the VM, and both are in a different region
from the users, who are in India.

Redis is not a nice-to-have here. It carries the tick cache with a 120 s TTL, the pub/sub bus that
fans prices to replicas, and — after [0003](./0003-api-worker-role-split.md) — the OTP store, the
Socket.IO adapter and the commodity price fan-out. A round trip to Oregon on that path is not
acceptable.

## Decision

Both run as containers on the VM, on an internal Docker network, with **no published host ports**.
They are reachable only by service name (`postgres:5432`, `redis:6379`) from the app containers.

Redis runs with `--appendonly no --save ""` and, importantly, `--maxmemory-policy noeviction`.

## Consequences

- **Latency collapses.** Price reads and OTP writes are now same-host.
- **`rediss://` becomes `redis://`.** TLS is unnecessary on a private bridge network and only costs
  handshakes. No code change was needed — ioredis picks TLS from the URL scheme.
- **`sslmode=require&channel_binding=require` comes off `DATABASE_URL`**, and
  `connection_limit`/`pool_timeout` go on. Neon's pooler was doing connection management invisibly;
  a plain Postgres container will not, and Prisma's default pool is per process
  (`cpus * 2 + 1`), so N replicas would exhaust `max_connections=100`.
- **`noeviction` is deliberate.** Under memory pressure `allkeys-lru` would silently evict a `tick:*`
  key (breaking cold-replica hydration) or an in-flight `otp:*` key (breaking one user's password
  reset, undebuggably). The working set is tiny; `noeviction` turns a runaway into a loud
  `OOM command not allowed` instead of quiet data loss.
- **No Redis persistence.** Losing the board on a restart is harmless — it re-hydrates from the live
  feed within a second — and the only semi-durable data is a 10-minute OTP.
- **Losing the volume loses the database.** This is the cost of the decision and the reason
  [0001](./0001-single-vm-docker-compose.md) drags a backup script along with it.
