# 0007 — Start on a fresh, empty database

**Status:** accepted, 2026-08-17

## Context

Live data sits in Neon. The new stack runs its own Postgres container
([0002](./0002-internal-postgres-and-redis.md)). Either the Neon data is dumped and restored into it,
or the new database starts empty and `prisma migrate deploy` builds the schema from the three
committed migrations.

## Decision

Start empty. No data migration.

This was raised explicitly with the owner, including the consequence below, and confirmed.

## Consequences

- **Every existing user's balance, portfolio, orders, transactions and open short positions cease to
  exist at cutover.** Open shorts are the sharpest edge: they represent (paper) money a user is
  currently exposed on, and they will simply be gone. This is a product decision, not merely an
  operational one.
- **Everyone is logged out on the web anyway**, independently of the data: the session cookie is
  host-only with no `Domain` attribute, so a cookie issued by the Render host does not carry to the
  new one. Mobile is unaffected on this axis — it uses `Authorization: Bearer` from secure storage —
  but its tokens reference user IDs that no longer exist, so it will 401 into a re-login.
- **`JWT_SECRET` and `JWT_REFRESH_SECRET` should be regenerated** as part of the cutover. Keeping
  them would leave old refresh tokens cryptographically valid for seven days against a database where
  their subject does not exist — valid signature, missing user, confusing failures.
- **The cutover gets much simpler.** No dump/restore step, no row-count reconciliation, no window
  during which two databases both accept writes. The parallel run in
  [0008](./0008-new-subdomain-parallel-run.md) is a functional comparison, not a data race.
- **Rollback is still clean.** Render and Neon stay up and untouched; reverting means pointing the
  clients back, and the old data is exactly where it was.
- If this is ever reconsidered, the migration is a `pg_dump -Fc` from Neon and a `pg_restore` into the
  container — the schema is identical, since both come from the same Prisma migrations.
