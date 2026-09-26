#!/usr/bin/env bash
# Optio-New — pg_dump to Hetzner Storage Box (SPEC §12.5).
# Schedule with scripts/secrets.sh run so sops decrypt never lands in a unit file.
# Modes: auto (restic, else borg), restic, borg, sftp, rsync.
# Runbook: docs/ops/postgres-storagebox-backup.md
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/storagebox-common.sh
source "${ROOT}/scripts/lib/storagebox-common.sh"

WORKDIR=""
on_exit() {
  local code=$?
  if [[ -n "$WORKDIR" && -d "$WORKDIR" ]]; then
    rm -rf "$WORKDIR"
  fi
  if [[ "$code" -ne 0 ]]; then
    storagebox_alert_failure "$code" "postgres backup" || true
  fi
  exit "$code"
}
trap on_exit EXIT

storagebox_require_database_url
storagebox_apply_keep_defaults
MODE="$(storagebox_resolve_mode)"

case "$MODE" in
  restic) storagebox_prepare_restic ;;
  borg) storagebox_prepare_borg ;;
  sftp | rsync)
    storagebox_validate_ssh
    command -v rsync >/dev/null 2>&1 || storagebox_die "install rsync"
    command -v sftp >/dev/null 2>&1 || storagebox_die "install sftp"
    ;;
esac
command -v pg_dump >/dev/null 2>&1 || storagebox_die "install pg_dump"
command -v gzip >/dev/null 2>&1 || storagebox_die "install gzip"

umask 077
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/optio-new-pg.XXXXXX")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="${WORKDIR}/optio-new-pg-${STAMP}.sql.gz"

echo "[optio-new] dumping postgres mode=${MODE}"
pg_dump --no-password --no-owner --no-privileges "$OPTIO_NEW_DATABASE_URL" | gzip -c >"$DUMP"
storagebox_assert_pg_dump_gzip "$DUMP"

case "$MODE" in
  restic)
    restic ${RESTIC_OPTS+"${RESTIC_OPTS[@]}"} backup \
      --tag optio-new --tag postgres --host optio-new \
      --stdin-filename optio-new-postgres.sql.gz --stdin <"$DUMP"
    restic ${RESTIC_OPTS+"${RESTIC_OPTS[@]}"} forget \
      --tag optio-new --tag postgres --host optio-new \
      --group-by host,tags \
      --keep-daily "$OPTIO_NEW_BACKUP_KEEP_DAILY" \
      --keep-weekly "$OPTIO_NEW_BACKUP_KEEP_WEEKLY" \
      --keep-monthly "$OPTIO_NEW_BACKUP_KEEP_MONTHLY" \
      --prune
    ;;
  borg)
    ln -f "$DUMP" "${WORKDIR}/optio-new-postgres.sql.gz"
    (
      cd "$WORKDIR"
      borg ${BORG_CREATE_OPTS+"${BORG_CREATE_OPTS[@]}"} create --stats --compression zstd \
        "::optio-new-pg-${STAMP}" optio-new-postgres.sql.gz
    )
    if borg prune --help 2>/dev/null | grep -q -- '--match-archives'; then
      borg ${BORG_CREATE_OPTS+"${BORG_CREATE_OPTS[@]}"} prune \
        --match-archives 'sh:optio-new-pg-*' \
        --keep-daily "$OPTIO_NEW_BACKUP_KEEP_DAILY" \
        --keep-weekly "$OPTIO_NEW_BACKUP_KEEP_WEEKLY" \
        --keep-monthly "$OPTIO_NEW_BACKUP_KEEP_MONTHLY"
    else
      borg ${BORG_CREATE_OPTS+"${BORG_CREATE_OPTS[@]}"} prune \
        --glob-archives 'optio-new-pg-*' \
        --keep-daily "$OPTIO_NEW_BACKUP_KEEP_DAILY" \
        --keep-weekly "$OPTIO_NEW_BACKUP_KEEP_WEEKLY" \
        --keep-monthly "$OPTIO_NEW_BACKUP_KEEP_MONTHLY"
    fi
    ;;
  sftp)
    storagebox_upload_sftp "$DUMP"
    storagebox_prune_remote_dumps
    ;;
  rsync)
    storagebox_upload_rsync "$DUMP"
    storagebox_prune_remote_dumps
    ;;
esac

echo "[optio-new] backup done mode=${MODE} stamp=${STAMP}"
