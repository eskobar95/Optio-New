#!/usr/bin/env bash
# Download the latest Postgres dump and check gzip + the pg_dump header.
# Does not connect to Postgres and does not apply SQL.
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
  exit "$code"
}
trap on_exit EXIT

storagebox_apply_keep_defaults
MODE="$(storagebox_resolve_mode)"
umask 077
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/optio-new-pg-dry-run.XXXXXX")"
TARGET="${WORKDIR}/dump.sql.gz"

case "$MODE" in
  restic)
    storagebox_prepare_restic
    snaps="$(restic ${RESTIC_OPTS+"${RESTIC_OPTS[@]}"} snapshots --json --tag optio-new --tag postgres --host optio-new)"
    if [[ -z "$snaps" || "$snaps" == "[]" || "$snaps" == "null" ]]; then
      storagebox_die "no restic snapshots tagged optio-new and postgres"
    fi
    restic ${RESTIC_OPTS+"${RESTIC_OPTS[@]}"} dump \
      --tag optio-new --tag postgres --host optio-new \
      latest optio-new-postgres.sql.gz >"$TARGET"
    ;;
  borg)
    storagebox_prepare_borg
    archive="$(borg ${BORG_CREATE_OPTS+"${BORG_CREATE_OPTS[@]}"} list --short | grep '^optio-new-pg-' | tail -n 1 || true)"
    [[ -n "$archive" ]] || storagebox_die "no borg archives named optio-new-pg-*"
    path="$(borg ${BORG_CREATE_OPTS+"${BORG_CREATE_OPTS[@]}"} list --short "::$archive" | grep -E 'optio-new-postgres\.sql\.gz$|optio-new-pg-[0-9]{8}T[0-9]{6}Z\.sql\.gz$' | tail -n 1 || true)"
    [[ -n "$path" ]] || storagebox_die "borg archive ${archive} has no postgres dump"
    borg ${BORG_CREATE_OPTS+"${BORG_CREATE_OPTS[@]}"} extract --stdout "::$archive" "$path" >"$TARGET"
    ;;
  sftp | rsync)
    storagebox_validate_ssh
    command -v rsync >/dev/null 2>&1 || storagebox_die "install rsync"
    latest="$(storagebox_list_dumps | LC_ALL=C sort | tail -n 1 || true)"
    [[ -n "$latest" ]] || storagebox_die "no optio-new-pg-*.sql.gz dumps in ${OPTIO_NEW_BACKUP_REMOTE_DIR}"
    storagebox_download_dump "$latest" "$TARGET"
    ;;
esac

storagebox_assert_pg_dump_gzip "$TARGET"
echo "[optio-new] restore dry-run passed mode=${MODE}; database was not modified"
