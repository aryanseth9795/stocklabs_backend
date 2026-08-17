# 0005 — Nginx with `resolver` + variable `proxy_pass`

**Status:** accepted, 2026-08-17

## Context

Scaling with `docker compose --scale api=N` changes how many containers answer to the `api` service
name. The load balancer has to notice.

Open-source Nginx **cannot re-resolve an `upstream` block's DNS at runtime** — `server ... resolve` is
an NGINX Plus directive. A static `upstream api_pool { server api:4000; }` resolves once at startup,
caches that one address, and never sees a replica added or removed.

## Decision

Docker's embedded DNS, re-resolved per request:

```nginx
resolver 127.0.0.11 valid=1s ipv6=off;
set $api_backend "api:4000";
proxy_pass http://$api_backend;      # no trailing path — see below
```

Alternatives considered:

| Option | Why not |
|---|---|
| Pre-declared replica hostnames (`api-1`, `api-2`, …) | Nginx **refuses to start** if any name in an `upstream` block fails to resolve at config load, so you must always run exactly the declared count. Defeats `--scale` entirely. |
| Templated `upstream` regenerated on scale + `nginx -s reload` | Keeps `least_conn`, `keepalive`, `max_fails`. But scaling stops being one command, and the config silently drifts the first time someone runs `--scale` without the script. |
| Traefik | Genuinely better at one thing — it deregisters on the Docker *stop event*, with no DNS TTL involved, closing the window below. Costs mounting `/var/run/docker.sock` into a network-facing container, which is a root-equivalent escalation path on a single VM. |
| Caddy | Nicer dynamic upstreams and automatic ACME, but rate limiting needs a plugin, which needs building a custom image — and rate limiting on the auth routes is a hard requirement. |

## Consequences

What this gives up, stated plainly:

- **No `ip_hash` / `least_conn`.** DNS round-robin instead; balancing granularity is the DNS TTL, not
  the request. Fine here — see [0006](./0006-no-sticky-sessions.md).
- **No passive health checks.** Docker DNS drops a record when a container *stops*, not when its
  healthcheck fails, so an up-but-broken replica keeps receiving traffic. Mitigated by making
  `/readyz` narrow and by gating `server.listen()` on hydration, so a warming replica refuses
  connections (ECONNREFUSED, which *is* retried) rather than serving 503s.
- **No upstream `keepalive` pool** — that directive only exists inside a named `upstream`. Every
  proxied request opens a fresh TCP connection. Noise at this traffic level.
- **A deregistration window.** After a container exits, Nginx may hold its cached address for up to
  `valid=`. In that window a POST to the dead address 502s and is deliberately *not* retried
  (see below). At `valid=1s` that is roughly one second per replica per deploy. **This is inherent to
  DNS-based discovery on OSS Nginx and cannot be fully closed.** If one potentially-failed POST per
  replica per deploy is unacceptable, that — and only that — is the argument for Traefik.

Two configuration details that are easy to get wrong:

- **No trailing path on `proxy_pass`.** With a variable, Nginx does not apply the location's URI
  substitution; writing `proxy_pass http://$api_backend/;` would rewrite every request path.
- **`proxy_next_upstream error timeout http_502 http_504` — never `non_idempotent`, never
  `http_503`.** `non_idempotent` is what most zero-downtime Nginx tutorials recommend and on a
  trading API it turns a deploy blip into a duplicate order and a duplicate balance debit. `http_503`
  is wrong for a different reason: the 503s here are the application's *business* response ("no live
  price"), the price feed is shared through Redis so a peer returns the same answer, and retrying
  only masks a real outage.
