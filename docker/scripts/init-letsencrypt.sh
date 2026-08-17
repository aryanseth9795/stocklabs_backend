#!/usr/bin/env bash
#
# First-boot certificate bootstrap. Run ONCE, on a fresh VM, before the first
# `docker compose up -d`.
#
#   bash docker/scripts/init-letsencrypt.sh
#
# WHY THIS EXISTS
#
# There is a deadlock on a fresh machine:
#   * nginx.conf's :443 server block names ssl_certificate paths under
#     /etc/letsencrypt/live/$ACME_DOMAIN/. If those files are absent, nginx
#     fails its config test and refuses to start.
#   * certbot's http-01 webroot challenge is served BY nginx on :80.
#   * So nginx cannot start without certs, and certs cannot be issued without
#     nginx.
#
# The standard break is to plant a throwaway self-signed pair so nginx boots,
# then let certbot replace it with the real thing and reload.
#
# Idempotent: if a real Let's Encrypt certificate is already present it exits
# without touching anything.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found. Copy .env.example and fill it in first." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${ACME_DOMAIN:?ACME_DOMAIN must be set in $ENV_FILE (e.g. api.example.com)}"
: "${ACME_EMAIL:?ACME_EMAIL must be set in $ENV_FILE}"

# Use the Let's Encrypt STAGING environment unless explicitly told otherwise.
# Production has a duplicate-certificate limit of 5 per week, and a typo'd
# domain in a retry loop burns through it in minutes — after which you wait.
# Prove the whole flow works against staging, then re-run with ACME_STAGING=0.
STAGING="${ACME_STAGING:-1}"

LIVE_DIR="./certbot/conf/live/${ACME_DOMAIN}"

echo "==> domain:  ${ACME_DOMAIN}"
echo "==> email:   ${ACME_EMAIL}"
if [[ "$STAGING" == "1" ]]; then
  echo "==> mode:    STAGING (untrusted certs — browsers will warn; this is expected)"
  echo "             re-run with ACME_STAGING=0 once this succeeds"
else
  echo "==> mode:    PRODUCTION"
fi

mkdir -p ./certbot/conf ./certbot/www ./certbot/log

# ---------------------------------------------------------------------------
# Already have a real certificate? Then there is nothing to bootstrap.
# ---------------------------------------------------------------------------
if [[ -f "${LIVE_DIR}/fullchain.pem" && ! -f "${LIVE_DIR}/.self-signed" ]]; then
  echo "==> A certificate already exists at ${LIVE_DIR} — nothing to do."
  echo "    Renewal is handled by the certbot service on its own loop."
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Plant a self-signed placeholder so nginx can pass `nginx -t` and boot.
# ---------------------------------------------------------------------------
echo "==> Planting a temporary self-signed certificate so nginx can start"
mkdir -p "${LIVE_DIR}"
docker run --rm \
  -v "${ROOT_DIR}/certbot/conf:/etc/letsencrypt" \
  --entrypoint openssl \
  certbot/certbot \
  req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "/etc/letsencrypt/live/${ACME_DOMAIN}/privkey.pem" \
    -out    "/etc/letsencrypt/live/${ACME_DOMAIN}/fullchain.pem" \
    -subj "/CN=${ACME_DOMAIN}"
touch "${LIVE_DIR}/.self-signed"

# ---------------------------------------------------------------------------
# 2. Start just the edge. The app tier is not needed to answer an ACME
#    challenge, and starting it now would mean debugging two things at once.
# ---------------------------------------------------------------------------
echo "==> Starting nginx"
docker compose -f "$COMPOSE_FILE" up -d nginx
sleep 3

if ! docker compose -f "$COMPOSE_FILE" exec -T nginx nginx -t 2>/dev/null; then
  echo "error: nginx will not accept its config. Fix that before requesting certs:" >&2
  docker compose -f "$COMPOSE_FILE" logs --tail 40 nginx >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Swap the placeholder for a real certificate.
# ---------------------------------------------------------------------------
echo "==> Requesting a certificate for ${ACME_DOMAIN}"
rm -rf "${LIVE_DIR}" "./certbot/conf/archive/${ACME_DOMAIN}" \
       "./certbot/conf/renewal/${ACME_DOMAIN}.conf"

STAGING_FLAG=""
[[ "$STAGING" == "1" ]] && STAGING_FLAG="--staging"

docker compose -f "$COMPOSE_FILE" run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
    $STAGING_FLAG \
    -d "${ACME_DOMAIN}" \
    --email "${ACME_EMAIL}" \
    --agree-tos \
    --no-eff-email \
    --non-interactive \
    --rsa-key-size 4096

echo "==> Reloading nginx with the real certificate"
docker compose -f "$COMPOSE_FILE" exec -T nginx nginx -s reload

echo
echo "==> Done."
if [[ "$STAGING" == "1" ]]; then
  echo "    That was a STAGING certificate — browsers will not trust it."
  echo "    Now re-run for real:   ACME_STAGING=0 bash docker/scripts/init-letsencrypt.sh"
else
  echo "    Certificate installed. The certbot service renews it every 12 h,"
  echo "    and nginx reloads every 6 h to pick up a renewal."
fi
