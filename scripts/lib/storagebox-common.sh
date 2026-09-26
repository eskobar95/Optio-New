#!/usr/bin/env bash
# Shared Storage Box helpers. Source only. No secret values live in this file.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "source this file; do not execute it" >&2
  exit 1
fi

STORAGEBOX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STORAGEBOX_RETENTION="${STORAGEBOX_ROOT}/scripts/lib/storagebox-retention.sh"

storagebox_die() {
  echo "[optio-new] $*" >&2
  exit 1
}

storagebox_require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    storagebox_die "set ${name}"
  fi
}

storagebox_positive_int() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    storagebox_die "${name} must be a positive integer"
  fi
}

storagebox_no_injection() {
  local name="$1"
  local value="$2"
  if [[ "$value" == *" "* || "$value" == *$'\n'* || "$value" == *$'\t'* || "$value" == -* ]]; then
    storagebox_die "${name} is invalid"
  fi
}

storagebox_apply_keep_defaults() {
  OPTIO_NEW_BACKUP_KEEP_DAILY="${OPTIO_NEW_BACKUP_KEEP_DAILY:-7}"
  OPTIO_NEW_BACKUP_KEEP_WEEKLY="${OPTIO_NEW_BACKUP_KEEP_WEEKLY:-4}"
  OPTIO_NEW_BACKUP_KEEP_MONTHLY="${OPTIO_NEW_BACKUP_KEEP_MONTHLY:-6}"
  storagebox_positive_int OPTIO_NEW_BACKUP_KEEP_DAILY "$OPTIO_NEW_BACKUP_KEEP_DAILY"
  storagebox_positive_int OPTIO_NEW_BACKUP_KEEP_WEEKLY "$OPTIO_NEW_BACKUP_KEEP_WEEKLY"
  storagebox_positive_int OPTIO_NEW_BACKUP_KEEP_MONTHLY "$OPTIO_NEW_BACKUP_KEEP_MONTHLY"
}

storagebox_resolve_mode() {
  local requested="${OPTIO_NEW_BACKUP_MODE:-auto}"
  case "$requested" in
    restic | borg | sftp | rsync)
      printf '%s\n' "$requested"
      ;;
    auto)
      if command -v restic >/dev/null 2>&1; then
        printf 'restic\n'
      elif command -v borg >/dev/null 2>&1; then
        printf 'borg\n'
      else
        storagebox_die "install restic or borg, or set OPTIO_NEW_BACKUP_MODE=sftp or rsync"
      fi
      ;;
    *)
      storagebox_die "OPTIO_NEW_BACKUP_MODE must be auto, restic, borg, sftp, or rsync"
      ;;
  esac
}

storagebox_require_database_url() {
  storagebox_require OPTIO_NEW_DATABASE_URL
  storagebox_no_injection OPTIO_NEW_DATABASE_URL "$OPTIO_NEW_DATABASE_URL"
}

storagebox_require_repo() {
  storagebox_require OPTIO_NEW_BACKUP_REPO
  storagebox_require OPTIO_NEW_BACKUP_PASSWORD
  storagebox_no_injection OPTIO_NEW_BACKUP_REPO "$OPTIO_NEW_BACKUP_REPO"
  if [[ "$OPTIO_NEW_BACKUP_PASSWORD" == *$'\n'* ]]; then
    storagebox_die "OPTIO_NEW_BACKUP_PASSWORD is invalid"
  fi
}

storagebox_validate_remote_dir() {
  local dir="$1"
  if [[ ! "$dir" =~ ^[A-Za-z0-9._/-]+$ || "$dir" == *".."* || "$dir" == /* || "$dir" == */ ]]; then
    storagebox_die "OPTIO_NEW_BACKUP_REMOTE_DIR must be a relative path without '..'"
  fi
}

storagebox_validate_ssh() {
  storagebox_require OPTIO_NEW_BACKUP_SSH_HOST
  storagebox_require OPTIO_NEW_BACKUP_SSH_USER
  storagebox_require OPTIO_NEW_BACKUP_SSH_KEY_PATH
  OPTIO_NEW_BACKUP_SSH_PORT="${OPTIO_NEW_BACKUP_SSH_PORT:-23}"
  OPTIO_NEW_BACKUP_REMOTE_DIR="${OPTIO_NEW_BACKUP_REMOTE_DIR:-backups/optio-new/postgres}"
  local host="$OPTIO_NEW_BACKUP_SSH_HOST"
  local user="$OPTIO_NEW_BACKUP_SSH_USER"
  local port="$OPTIO_NEW_BACKUP_SSH_PORT"
  local key="$OPTIO_NEW_BACKUP_SSH_KEY_PATH"
  [[ "$host" =~ ^[A-Za-z0-9.-]+$ && "$host" != -* ]] || storagebox_die "OPTIO_NEW_BACKUP_SSH_HOST is invalid"
  [[ "$user" =~ ^[A-Za-z0-9._-]+$ && "$user" != -* ]] || storagebox_die "OPTIO_NEW_BACKUP_SSH_USER is invalid"
  [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || storagebox_die "OPTIO_NEW_BACKUP_SSH_PORT is invalid"
  [[ "$key" != *" "* && "$key" != -* && -f "$key" ]] || storagebox_die "OPTIO_NEW_BACKUP_SSH_KEY_PATH must be an existing key file"
  storagebox_validate_remote_dir "$OPTIO_NEW_BACKUP_REMOTE_DIR"
  if [[ -n "${OPTIO_NEW_BACKUP_SSH_KNOWN_HOSTS:-}" ]]; then
    [[ "${OPTIO_NEW_BACKUP_SSH_KNOWN_HOSTS}" =~ ^[A-Za-z0-9._/-]+$ ]] || storagebox_die "OPTIO_NEW_BACKUP_SSH_KNOWN_HOSTS path is invalid"
  fi
}

storagebox_prepare_restic() {
  storagebox_require_repo
  command -v restic >/dev/null 2>&1 || storagebox_die "install restic"
  export RESTIC_REPOSITORY="$OPTIO_NEW_BACKUP_REPO"
  export RESTIC_PASSWORD="$OPTIO_NEW_BACKUP_PASSWORD"
  RESTIC_OPTS=()
  if [[ -n "${OPTIO_NEW_BACKUP_SFTP_COMMAND:-}" ]]; then
    if [[ "$OPTIO_NEW_BACKUP_SFTP_COMMAND" == *$'\n'* ]]; then
      storagebox_die "OPTIO_NEW_BACKUP_SFTP_COMMAND is invalid"
    fi
    RESTIC_OPTS+=(-o "sftp.command=${OPTIO_NEW_BACKUP_SFTP_COMMAND}")
  fi
}

storagebox_prepare_borg() {
  storagebox_require_repo
  command -v borg >/dev/null 2>&1 || storagebox_die "install borg"
  export BORG_REPO="$OPTIO_NEW_BACKUP_REPO"
  export BORG_PASSPHRASE="$OPTIO_NEW_BACKUP_PASSWORD"
  if [[ -n "${OPTIO_NEW_BACKUP_SSH_KEY_PATH:-}" ]]; then
    [[ -f "$OPTIO_NEW_BACKUP_SSH_KEY_PATH" && "$OPTIO_NEW_BACKUP_SSH_KEY_PATH" != *" "* ]] || storagebox_die "OPTIO_NEW_BACKUP_SSH_KEY_PATH must be an existing key file"
    local port="${OPTIO_NEW_BACKUP_SSH_PORT:-23}"
    [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || storagebox_die "OPTIO_NEW_BACKUP_SSH_PORT is invalid"
    export BORG_RSH="ssh -i ${OPTIO_NEW_BACKUP_SSH_KEY_PATH} -p ${port} -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
  fi
  BORG_CREATE_OPTS=()
  if [[ -n "${OPTIO_NEW_BACKUP_BORG_REMOTE_PATH:-}" ]]; then
    storagebox_no_injection OPTIO_NEW_BACKUP_BORG_REMOTE_PATH "$OPTIO_NEW_BACKUP_BORG_REMOTE_PATH"
    BORG_CREATE_OPTS+=(--remote-path "$OPTIO_NEW_BACKUP_BORG_REMOTE_PATH")
  fi
}

storagebox_rsh() {
  local port="${OPTIO_NEW_BACKUP_SSH_PORT:-23}"
  local key="$OPTIO_NEW_BACKUP_SSH_KEY_PATH"
  local rsh="ssh -p ${port} -i ${key} -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=120"
  if [[ -n "${OPTIO_NEW_BACKUP_SSH_KNOWN_HOSTS:-}" ]]; then
    rsh+=" -o UserKnownHostsFile=${OPTIO_NEW_BACKUP_SSH_KNOWN_HOSTS}"
  fi
  printf '%s\n' "$rsh"
}

storagebox_sftp_batch() {
  local batch="$1"
  local port="${OPTIO_NEW_BACKUP_SSH_PORT:-23}"
  local args=(
    sftp
    -P "$port"
    -i "$OPTIO_NEW_BACKUP_SSH_KEY_PATH"
    -o BatchMode=yes
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes
  )
  if [[ -n "${OPTIO_NEW_BACKUP_SSH_KNOWN_HOSTS:-}" ]]; then
    args+=(-o "UserKnownHostsFile=${OPTIO_NEW_BACKUP_SSH_KNOWN_HOSTS}")
  fi
  args+=(-b - "${OPTIO_NEW_BACKUP_SSH_USER}@${OPTIO_NEW_BACKUP_SSH_HOST}")
  printf '%s\n' "$batch" | "${args[@]}"
}

storagebox_mkdir_remote() {
  local dir="$OPTIO_NEW_BACKUP_REMOTE_DIR"
  local prefix="" part batch=""
  local IFS=/
  read -ra parts <<<"$dir"
  for part in "${parts[@]}"; do
    [[ -z "$part" ]] && continue
    if [[ -z "$prefix" ]]; then
      prefix="$part"
    else
      prefix="${prefix}/${part}"
    fi
    batch+="-mkdir ${prefix}"$'\n'
  done
  storagebox_sftp_batch "$batch"
}

storagebox_list_dumps() {
  local rsh dest listing
  rsh="$(storagebox_rsh)"
  dest="${OPTIO_NEW_BACKUP_SSH_USER}@${OPTIO_NEW_BACKUP_SSH_HOST}:${OPTIO_NEW_BACKUP_REMOTE_DIR}/"
  if ! listing="$(rsync --list-only -e "$rsh" "$dest")"; then
    storagebox_die "rsync could not list ${OPTIO_NEW_BACKUP_REMOTE_DIR}"
  fi
  printf '%s\n' "$listing" | awk '{ print $NF }' | grep -E '^optio-new-pg-[0-9]{8}T[0-9]{6}Z\.sql\.gz$' || true
}

storagebox_upload_sftp() {
  local dump="$1"
  local base
  base="$(basename "$dump")"
  storagebox_mkdir_remote
  storagebox_sftp_batch "put ${dump} ${OPTIO_NEW_BACKUP_REMOTE_DIR}/${base}"
}

storagebox_upload_rsync() {
  local dump="$1"
  local base rsh
  base="$(basename "$dump")"
  rsh="$(storagebox_rsh)"
  storagebox_mkdir_remote
  rsync -a -e "$rsh" "$dump" "${OPTIO_NEW_BACKUP_SSH_USER}@${OPTIO_NEW_BACKUP_SSH_HOST}:${OPTIO_NEW_BACKUP_REMOTE_DIR}/${base}"
}

storagebox_download_dump() {
  local name="$1"
  local dest="$2"
  local rsh
  rsh="$(storagebox_rsh)"
  rsync -a -e "$rsh" \
    "${OPTIO_NEW_BACKUP_SSH_USER}@${OPTIO_NEW_BACKUP_SSH_HOST}:${OPTIO_NEW_BACKUP_REMOTE_DIR}/${name}" \
    "$dest"
}

storagebox_prune_remote_dumps() {
  local names plan action name batch
  names="$(storagebox_list_dumps)"
  plan="$(printf '%s\n' "$names" | bash "$STORAGEBOX_RETENTION" "$(date -u +%s)")"
  batch=""
  while read -r action name; do
    [[ "$action" == "drop" ]] || continue
    [[ "$name" =~ ^optio-new-pg-[0-9]{8}T[0-9]{6}Z\.sql\.gz$ ]] || continue
    batch+="rm ${OPTIO_NEW_BACKUP_REMOTE_DIR}/${name}"$'\n'
  done <<<"$plan"
  if [[ -n "$batch" ]]; then
    storagebox_sftp_batch "$batch"
  fi
}

storagebox_assert_pg_dump_gzip() {
  local file="$1"
  [[ -s "$file" ]] || storagebox_die "dump is empty"
  gzip -t "$file" || storagebox_die "dump failed gzip integrity check"
  local header
  header="$(gzip -dc "$file" | head -n 40 || true)"
  grep -q -F 'PostgreSQL database dump' <<<"$header" || storagebox_die "dump is not a plain pg_dump SQL archive"
}

storagebox_alert_failure() {
  local code="$1"
  local job="$2"
  echo "[optio-new] ${job} failed (exit ${code})" >&2
  if command -v logger >/dev/null 2>&1; then
    logger -t optio-new-backup -p user.err -- "${job} failed exit=${code}" || true
  fi
  local hook="${OPTIO_NEW_BACKUP_ALERT_WEBHOOK:-}"
  if [[ -z "$hook" ]]; then
    echo "[optio-new] OPTIO_NEW_BACKUP_ALERT_WEBHOOK unset; failure is the non-zero exit" >&2
    return 0
  fi
  if [[ ! "$hook" =~ ^https?:// ]]; then
    echo "[optio-new] OPTIO_NEW_BACKUP_ALERT_WEBHOOK must be an http(s) URL; not sending" >&2
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "[optio-new] curl is missing; webhook was not sent" >&2
    return 0
  fi
  local text payload
  text="Optio-New ${job} failed (exit ${code})"
  payload="$(printf '{"source":"optio-new","event":"postgres_backup_failed","exit_code":%s,"text":"%s","content":"%s"}' "$code" "$text" "$text")"
  curl --silent --show-error --max-time 15 --retry 2 \
    -H 'content-type: application/json' \
    --data "$payload" \
    -- "$hook" || echo "[optio-new] alert webhook delivery failed" >&2
  return 0
}
