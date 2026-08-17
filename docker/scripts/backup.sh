#!/bin/sh
#
# Nightly Postgres backup with rotation.
#
# Runs INSIDE the `backup` service (postgres:16-alpine), on the internal
# network, reaching the database over compose DNS. It therefore has psql/pg_dump
# but no Docker CLI and no Docker socket — do not reintroduce `docker compose
# exec` here.
#
# Invoked on a loop by the service's command: once immediately at deploy (so a
# broken backup config is discovered now, not 24 h later) and every 24 h after.
#
# Since the migration dropped managed Postgres, the files this writes are the
# only copy of the data that is not inside a single Docker volume.

set -eu

PGHOST="${PGHOST:-postgres}"
PGUSER="${POSTGRES_USER:-app}"
PGDATABASE="${POSTGRES_DB:-stocklabs}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# pg_dump reads this; it is already in the container env from .env.prod.
PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
export PGPASSWORD PGHOST PGUSER PGDATABASE

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%F-%H%M)"
OUT="$BACKUP_DIR/stocklabs-$STAMP.dump"

echo "[backup] $(date -Iseconds) dumping $PGDATABASE from $PGHOST -> $OUT"

# -Fc is the custom format: compressed, and restorable selectively with
# pg_restore. Write to a .part first so a crash mid-dump cannot leave a
# truncated file that later looks like a valid backup.
if ! pg_dump -Fc "$PGDATABASE" > "$OUT.part"; then
  echo "[backup] FAILED: pg_dump exited non-zero" >&2
  rm -f "$OUT.part"
  exit 1
fi

if [ ! -s "$OUT.part" ]; then
  echo "[backup] FAILED: dump is empty" >&2
  rm -f "$OUT.part"
  exit 1
fi

# An unverified backup is not a backup. `--list` reads the archive's table of
# contents, which catches a truncated or corrupt dump now rather than at 3am on
# the day it is needed.
#
# This proves the file is well-formed. It does NOT prove it restores — do that
# by hand periodically, per docs/runbook.md.
if ! pg_restore --list "$OUT.part" > /dev/null 2>&1; then
  echo "[backup] FAILED: dump did not survive pg_restore --list" >&2
  rm -f "$OUT.part"
  exit 1
fi

mv "$OUT.part" "$OUT"
echo "[backup] ok — $(du -h "$OUT" | cut -f1)"

# Rotation runs only after a verified success, so a run of failures can never
# delete the last known-good backup.
DELETED=$(find "$BACKUP_DIR" -name 'stocklabs-*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
echo "[backup] rotated out $(echo "$DELETED" | tr -d ' ') file(s) older than ${RETENTION_DAYS}d"

# Leave a breadcrumb the runbook's triage step can read without parsing logs.
date -Iseconds > "$BACKUP_DIR/.last-success"
