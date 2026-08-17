#!/usr/bin/env bash
#
# Zero-downtime-ish rolling restart of the `api` tier.
#
#   bash docker/scripts/rolling-restart.sh
#
# Replaces api replicas ONE AT A TIME. After each replacement it waits for the
# new container to answer /readyz with 200 before touching the next one, so the
# fleet never loses more than 1/N of its capacity, and a broken build stops the
# rollout at the first replica instead of taking the whole tier down.
#
# Why not `docker compose up -d --force-recreate api`? Because compose stops
# every replica of a service before starting the replacements — a full outage
# for the length of the boot, which for this app includes Redis board hydration.
#
# Env overrides:
#   COMPOSE_FILE    default docker-compose.prod.yml
#   SERVICE         default api            (do NOT point this at `worker`)
#   STOP_TIMEOUT    default 45   seconds, matches stop_grace_period
#   READY_TIMEOUT   default 60   seconds to wait for /readyz per replica
#   RESOLVER_SETTLE default 3    seconds, must exceed nginx `resolver valid=`

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SERVICE="${SERVICE:-api}"
APP_PORT="${APP_PORT:-4000}"
STOP_TIMEOUT="${STOP_TIMEOUT:-45}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"
RESOLVER_SETTLE="${RESOLVER_SETTLE:-3}"

log()  { printf '[rolling-restart] %s\n' "$*"; }
fail() { printf '\n[rolling-restart] FATAL: %s\n' "$*" >&2; exit 1; }

trap 'fail "aborted on line ${LINENO}. The tier may be mid-rollout — run \"docker compose -f ${COMPOSE_FILE} ps\" before doing anything else."' ERR

dc() { docker compose -f "${COMPOSE_FILE}" "$@"; }

if [[ "${SERVICE}" == "worker" ]]; then
  fail "refusing to roll 'worker'. It is a singleton by design (one Binance upstream, one commodity feed, one midnight cron). Restart it directly with 'docker compose -f ${COMPOSE_FILE} restart worker' and accept the brief gap."
fi

command -v docker >/dev/null 2>&1 || fail "docker not found on PATH"
[[ -f "${COMPOSE_FILE}" ]] || fail "compose file not found: ${ROOT_DIR}/${COMPOSE_FILE}"

# ---------------------------------------------------------------------------
# Readiness probe.
#
# Runs INSIDE the target container using Node's global fetch — the runtime image
# has no curl and no wget, and we want to probe this specific replica rather
# than whatever DNS hands us. Identical to the compose healthcheck.
# ---------------------------------------------------------------------------
probe() {
  docker exec "$1" node -e \
    "fetch('http://127.0.0.1:${APP_PORT}/readyz').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))" \
    >/dev/null 2>&1
}

wait_ready() {
  local cid="$1" short="${1:0:12}" deadline
  deadline=$(( $(date +%s) + READY_TIMEOUT ))

  log "waiting for ${short} to report ready (timeout ${READY_TIMEOUT}s)..."
  while ! probe "${cid}"; do
    if (( $(date +%s) >= deadline )); then
      printf '\n----- last 60 log lines from %s -----\n' "${short}" >&2
      docker logs --tail 60 "${cid}" >&2 2>&1 || true
      printf -- '--------------------------------------\n\n' >&2
      fail "replica ${short} never became ready within ${READY_TIMEOUT}s. ROLLOUT STOPPED — the remaining replicas are still running the old version. Fix the image or the config and re-run; do not force this through."
    fi
    sleep 2
  done
  log "${short} is ready."
}

contains() {
  local needle="$1"; shift
  local item
  for item in "$@"; do [[ "${item}" == "${needle}" ]] && return 0; done
  return 1
}

# ---------------------------------------------------------------------------
# Snapshot the replicas we are going to replace.
# ---------------------------------------------------------------------------
mapfile -t ORIGINAL < <(dc ps -q "${SERVICE}")
REPLICAS="${#ORIGINAL[@]}"

(( REPLICAS > 0 )) || fail "no running containers for service '${SERVICE}'. Bring the stack up first: docker compose -f ${COMPOSE_FILE} up -d"

log "service=${SERVICE} replicas=${REPLICAS}"

if (( REPLICAS == 1 )); then
  log "WARNING: only 1 replica. There is nothing to shift traffic onto, so this"
  log "         WILL drop requests for the length of one boot. For a genuinely"
  log "         seamless roll, scale up first:"
  log "           docker compose -f ${COMPOSE_FILE} up -d --scale ${SERVICE}=2"
fi

SEEN=("${ORIGINAL[@]}")
INDEX=0

for cid in "${ORIGINAL[@]}"; do
  INDEX=$(( INDEX + 1 ))
  short="${cid:0:12}"
  log "=== replica ${INDEX}/${REPLICAS} (${short}) ==="

  # SIGTERM, then up to STOP_TIMEOUT for the app's own shutdown sequence:
  # flip /readyz to 503 -> 8 s drain -> close server -> disconnect local
  # sockets -> close SSE subscribers -> prisma/redis disconnect -> exit.
  log "stopping ${short} (grace ${STOP_TIMEOUT}s)"
  docker stop -t "${STOP_TIMEOUT}" "${cid}" >/dev/null

  # Remove it. Without this, `compose up` sees an existing (exited) container
  # for the service and simply STARTS IT AGAIN — same old image, same old
  # config — so a "rolling restart" after a rebuild would quietly deploy
  # nothing. Removing forces compose to create a fresh container from the
  # current image.
  docker rm "${cid}" >/dev/null

  # --no-deps: never touch postgres/redis/migrate.
  # --no-recreate: leave the replicas that are still serving completely alone;
  #                only the missing one gets created.
  log "starting replacement"
  dc up -d --no-deps --no-recreate --scale "${SERVICE}=${REPLICAS}" "${SERVICE}" >/dev/null

  mapfile -t CURRENT < <(dc ps -q "${SERVICE}")
  NEW=""
  for c in "${CURRENT[@]}"; do
    if ! contains "${c}" "${SEEN[@]}"; then NEW="${c}"; break; fi
  done
  [[ -n "${NEW}" ]] || fail "compose did not create a replacement container for ${SERVICE} (expected ${REPLICAS} running, found ${#CURRENT[@]}). ROLLOUT STOPPED."
  SEEN+=("${NEW}")

  wait_ready "${NEW}"

  # nginx discovers replicas through Docker DNS with `resolver ... valid=1s`,
  # so for up to one TTL it can still hold the address of the container we just
  # removed. Sleeping past the TTL guarantees that window is closed before the
  # next replica is taken out — otherwise two replicas could be missing from
  # DNS's point of view at the same time.
  log "settling ${RESOLVER_SETTLE}s past the nginx resolver TTL"
  sleep "${RESOLVER_SETTLE}"
done

trap - ERR
log "done — ${REPLICAS}/${REPLICAS} replicas replaced and ready."
dc ps "${SERVICE}"
