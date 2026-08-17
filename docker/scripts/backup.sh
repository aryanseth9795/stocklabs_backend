#!/usr/bin/env bash
#
# Nightly Postgres backup with rotation.
#
# Run from the host, from cron, next to docker-compose.prod.yml:
#   0 3 * * *  cd /srv/stocklabs && ./docker/scripts/backup.sh >> /var/log/stocklabs-backup.log 2>&1
#
# The database lives in a container volume that nothing else replicates. Since
# the migration dropped the managed Neon instance, this script is the only thing
# standing between a bad `docker volume rm` and total data loss.

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

# Read the credentials from the same env file the stack uses, so this can never
# drift from what the database was actually created with.
ENV_FILE="${ENV_FILE:-.env.prod}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

PG_USER="${POSTGRES_USER:-app}"
PG_DB="${POSTGRES_DB:-stocklabs}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%F-%H%M)"
OUT="$BACKUP_DIR/stocklabs-$STAMP.dump"

echo "[backup] $(date -Is) dumping $PG_DB -> $OUT"

# -Fc is the custom format: already compressed, and restorable selectively with
# pg_restore. -T (no TTY) matters under cron, where there is no terminal.
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$PG_USER" -Fc "$PG_DB" > "$OUT"

if [[ ! -s "$OUT" ]]; then
  echo "[backup] FAILED: dump is empty" >&2
  rm -f "$OUT"
  exit 1
fi

# An unverified backup is not a backup. `--list` reads the archive's table of
# contents, which is enough to catch a truncated or corrupt dump immediately
# rather than at 3am on the day you need it.
#
# This is NOT a substitute for periodically restoring into a scratch database
# and querying it — see docs/runbook.md. It only proves the file is well-formed.
if ! docker compose -f "$COMPOSE_FILE" exec -T postgres \
      pg_restore --list /dev/stdin < "$OUT" > /dev/null 2>&1; then
  echo "[backup] FAILED: dump did not survive pg_restore --list" >&2
  exit 1
fi

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup] ok — $SIZE"

# Rotation runs only after a verified success, so a run of failures can never
# delete the last known-good backup.
DELETED="$(find "$BACKUP_DIR" -name 'stocklabs-*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
echo "[backup] rotated out $DELETED file(s) older than ${RETENTION_DAYS}d"
