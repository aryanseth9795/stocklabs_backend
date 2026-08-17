# 0001 — Single VM running Docker Compose

**Status:** accepted, 2026-08-17

## Context

The backend ran on Render as a plain Node runtime, with Neon for Postgres and Render Key Value for
Redis. That worked, but it left the operator with no control over the egress IP (which matters — see
[0002](./0002-internal-postgres-and-redis.md) and the Binance geo-block in
[gotchas](../gotchas.md)), no ability to run more than one process without paying per instance, and
three separate vendors to reason about when something broke.

The requirement was to run the whole system on one VM under Docker, with the option to scale the Node
tier on demand.

## Decision

One VM. Docker Compose (`docker-compose.prod.yml`) describes the whole stack: Nginx, N `api`
replicas, one `worker`, Postgres, Redis, a one-shot `migrate`, Certbot, and a backup sidecar. Scaling
is `docker compose up -d --scale api=N`.

Kubernetes was not considered seriously. It solves multi-node scheduling, rolling deploys and service
discovery — none of which is a problem at one VM and a handful of replicas, and all of which it
charges for in operational surface. Compose gives the same replica model in a file one person can
read.

## Consequences

- **The VM is a single point of failure.** No multi-node failover. Accepted: this is a paper-trading
  platform, and the previous setup had comparable availability with less control.
- **Backups become the operator's job.** Neon did this invisibly. `docker/scripts/backup.sh` and the
  restore drill in the [runbook](../runbook.md) exist because of this decision.
- **Rate limiting and TLS become the operator's job too.** Render provided incidental edge
  protection; a bare VM provides none. Hence `limit_req` in the Nginx config, aimed particularly at
  `/api/v1/forget`, an unauthenticated email-sending route.
- **Egress IP is now fixed and known**, which is what makes the Binance reachability pre-flight
  meaningful, and what makes a per-IP rate limit a real constraint on the ingester.
- Migrating later to Swarm or Kubernetes stays open: the image is role-driven and stateless, so the
  unit of scheduling does not change.
