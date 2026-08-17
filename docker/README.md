# Operating the container stack

Everything runs from the repo root on the VM, alongside `docker-compose.prod.yml` and a `.env.prod`
you create from [`../.env.example`](../.env.example).

For *why* any of this is shaped the way it is, see [`../docs/`](../docs/). This file is the
short operational reference.

```
docker/
├── nginx/
│   ├── nginx.conf              TLS, rate limiting, WS upgrade, SSE, LB
│   └── snippets/proxy-common.conf
└── scripts/
    ├── rolling-restart.sh      replace api replicas one at a time
    └── backup.sh               nightly pg_dump + verify + rotate
```

## ⚠ Never scale `worker` past 1

```bash
docker compose -f docker-compose.prod.yml up -d --scale api=4    # ✅
docker compose -f docker-compose.prod.yml up -d --scale worker=2 # ❌ never
```

`worker` owns the single Binance connection, the single commodity feed, and the midnight auto-cut
cron. A second one means two connections from one IP against a per-IP rate limit, duplicate ticks
amplified across every subscriber, two upstream connections to a third party, and the midnight job
scanning every open short twice. See [`../docs/scaling.md`](../docs/scaling.md).

## Bring it up

```bash
cp .env.example .env.prod && $EDITOR .env.prod    # fill in every CHANGEME
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps      # all healthy; migrate exited 0
```

`migrate` is a one-shot `prisma migrate deploy`; `api` and `worker` wait for it to complete
successfully. If it exits non-zero nothing else starts — that is intentional.

## Scale

```bash
docker compose -f docker-compose.prod.yml up -d --scale api=4
```

No Nginx reload needed. It re-resolves the `api` service name through Docker's DNS every second, so
new replicas enter rotation on their own — see
[ADR 0005](../docs/decisions/0005-nginx-dns-resolver-load-balancing.md).

## Deploy a new version

```bash
docker compose -f docker-compose.prod.yml build api
bash docker/scripts/rolling-restart.sh
```

Replaces replicas one at a time, waiting for each new container's `/readyz` before touching the next.
A broken build stops the rollout at the first replica instead of taking the tier down.

Do **not** use `docker compose up -d --force-recreate api` — compose stops every replica before
starting the replacements, which is a full outage for the length of a boot.

## Back up and restore

```bash
bash docker/scripts/backup.sh                     # dump, verify, rotate at 14 days
# cron: 0 3 * * *  cd /srv/stocklabs && ./docker/scripts/backup.sh >> /var/log/stocklabs-backup.log 2>&1
```

The script proves the dump is well-formed. It does **not** prove it restores — do that by hand
periodically, per [`../docs/runbook.md`](../docs/runbook.md). Since the migration dropped managed
Postgres, this is the only copy of the data.

## Health

```bash
curl -s http://localhost/healthz     # blocked at nginx (404) — hit the container directly
docker compose -f docker-compose.prod.yml exec api \
  node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>r.json()).then(o=>console.log(o))"
```

`/healthz` and `/readyz` return 404 through Nginx on purpose: `/readyz` runs a database probe and
would otherwise be an unauthenticated liveness oracle.

- **`/healthz`** — liveness. Checks nothing, deliberately. A liveness probe that depended on Redis
  would mark every container unhealthy during a ten-second blip and restart the whole fleet at once.
- **`/readyz`** — readiness, and the main observability surface. It fails only on conditions specific
  to *that* replica; shared conditions (a dead Binance feed) are reported in the body but do not gate,
  because gating would pull the entire fleet out of rotation during an outage that affects everyone
  equally.

## Certificates

Certbot runs as a sidecar using the webroot challenge and renews on a loop. **Rehearse against Let's
Encrypt staging first** — the duplicate-certificate limit is five per week and a typo'd domain in a
retry loop burns through it fast.

## Logs

```bash
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f worker    # ticks, commodity feed, cron
```

The worker prints the 60-second board snapshot and the "price feed is DOWN" alarm. `api` replicas
deliberately do not — that counter only increments on the ingest path, so on an `api` replica the
alarm would fire every minute forever while the feed was perfectly healthy.
