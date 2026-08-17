# StockLabs Server — Deployment Docs

Why this backend is laid out the way it is after the move from Render to Docker on a VM, and how to
operate it. Written so the reasoning survives without the conversation that produced it.

| Document | What it answers |
|---|---|
| [architecture.md](./architecture.md) | What runs where, the `api`/`worker` split, how a Binance tick becomes a client update, what scales and what cannot |
| [scaling.md](./scaling.md) | How to scale `api`, why `worker` must stay at exactly 1, and what state had to move to Redis for replicas to be safe |
| [gotchas.md](./gotchas.md) | The traps found during design — symptom, cause, fix. Read this before changing sockets, shutdown, the Dockerfile, or the Nginx config |
| [runbook.md](./runbook.md) | Deploy, scale, restart, back up, restore, renew certs, read `/readyz`, triage, and the cutover sequence |
| [decisions/](./decisions/) | One ADR per decision — context, decision, consequences |

## Decisions

| ADR | Decision |
|---|---|
| [0001](./decisions/0001-single-vm-docker-compose.md) | Single VM running Docker Compose, not managed hosting and not Kubernetes |
| [0002](./decisions/0002-internal-postgres-and-redis.md) | Postgres and Redis as internal containers, leaving Neon and Render Key Value |
| [0003](./decisions/0003-api-worker-role-split.md) | Split the process into an `api` role (N replicas) and a `worker` role (exactly 1) |
| [0004](./decisions/0004-one-image-role-env-var.md) | One image, role selected by a `ROLE` env var — not two images |
| [0005](./decisions/0005-nginx-dns-resolver-load-balancing.md) | Nginx with `resolver` + variable `proxy_pass`, not templated upstreams, Traefik, or Caddy |
| [0006](./decisions/0006-no-sticky-sessions.md) | No sticky sessions — safe only because both clients are websocket-only |
| [0007](./decisions/0007-fresh-empty-database.md) | Start on a fresh, empty database; no data migration from Neon |
| [0008](./decisions/0008-new-subdomain-parallel-run.md) | New subdomain with Let's Encrypt, parallel run against Render, then an explicit cutover |

## Status

**As of 2026-08-17: mostly planned, partly implemented.** All of this lives on branch `prod`; `main`
still deploys to Render and is untouched.

| Piece | State at time of writing |
|---|---|
| `package.json` — `cors`, `@types/cors`, `prisma` moved to `dependencies`, `@socket.io/redis-adapter`, `engines`, `main`, `migrate` script | Landed |
| `src/config/env.ts` — `ROLE` (`api` / `worker` / `all`, strict on a bad value), `CORS_ORIGINS`, `BINANCE_WS_BASE`, `REDIS_URL` required outside dev | Landed |
| `src/db/redis.ts` — shared lazily-connected clients + a dedicated pair for the Socket.IO adapter | Landed |
| Role split wiring in `app.ts`; commodity prices through Redis; `io.local` board broadcast; adapter-based single-session enforcement; graceful shutdown; `/healthz` + `/readyz` | Landed |
| OTP store in Redis; crypto staleness guard in `getLivePriceINR`; `setCommodityPriceAt` | Landed |
| `Dockerfile`, `docker-compose.prod.yml`, `docker/nginx/**`, `docker/scripts/**`, `.dockerignore`, `.env.example` | Landed |
| Built and run as containers end to end | **Not yet — nothing in this stack has been `docker build`-ed or started** |
| VM, DNS, certs, cutover | Not started |

Verified so far: `npx tsc --noEmit` clean, and `npm test` green at 80/80 with the process exiting on
its own (which is the check that the Redis clients stayed lazy and the suite stayed hermetic).

Each document repeats a `Status:` line of its own. Where a doc describes something not yet in the
tree it says so on the spot. If a claim here disagrees with the code, the code wins — these docs are
the *reasoning*, not the source of truth for behaviour.

## Sources

- The approved plan: `C:\Users\ARYAN\.claude\plans\create-a-new-branch-rosy-flute.md`
- The earlier code review this builds on: `D:\Desktop\StockLabs\review\` — findings **D-3** (OTP store
  in process memory), **D-5** (single-session disconnect relies on event ordering), **S-14** (Redis
  tick key mismatch), **S-15** (Binance reconnect storm), and the geo-blocked Binance futures endpoint
  (`review/phase-1-server.md:759-774`) are all load-bearing here.
