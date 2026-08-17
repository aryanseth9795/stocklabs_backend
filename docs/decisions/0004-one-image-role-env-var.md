# 0004 — One image, role selected by a `ROLE` env var

**Status:** accepted, 2026-08-17

## Context

[0003](./0003-api-worker-role-split.md) created two roles. They could ship as two images (separate
Dockerfiles or separate entrypoints), or as one image whose behaviour is selected at runtime.

## Decision

One image. `ROLE` is read once in `src/config/env.ts` and exposed as `isApi` / `isWorker`; compose
sets it per service. Both services run the identical image digest.

`ROLE` is **optional, defaulting to `all`** (meaning both), but **throws on an unrecognised value**.

## Consequences

- **What you test as `api` is byte-for-byte what runs as `worker`.** A two-image setup can drift —
  different base layers, different dependency resolution — and the divergence surfaces only in
  production, on the one service that has no replica to fall back on.
- **`all` is exactly the previous single-process behaviour**, which makes the whole refactor a
  provable no-op for local development and for the still-live Render deployment on `main`.
- **`ROLE` could not be made required.** Every test file transitively imports `env.ts`, so a throw at
  import time would take all 80 tests down; `npm run dev` would also need a new env var. Optional with
  a safe default avoids both.
- **But a bad value must not fall back.** A typo'd `ROLE=Api ` quietly resolving to `all` would put a
  Binance ingester and a midnight cron inside every API replica — the exact failure the split exists
  to prevent, reintroduced by a whitespace character. Hence: lowercase-normalise, check against an
  allow-list, throw.
- The gates are single `if (isWorker)` / `if (isApi)` wrappers at each call site rather than a
  restructuring of `app.ts`, which keeps the diff reviewable against the original.
