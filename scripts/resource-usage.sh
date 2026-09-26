#!/usr/bin/env bash
# Report free disk, inodes, and memory for kit-harness ops.
# Prints paths and counts only. Does not print secret env values.
set -euo pipefail

worktree_root="${OPTIO_NEW_WORKTREE_ROOT:-/var/lib/optio-new/worktrees}"
docker_root="${OPTIO_NEW_DOCKER_DATA_ROOT:-/var/lib/docker}"
min_disk="${OPTIO_NEW_MIN_FREE_DISK_BYTES:-2147483648}"
min_inodes="${OPTIO_NEW_MIN_FREE_INODES:-10000}"
min_mem="${OPTIO_NEW_MIN_AVAILABLE_MEMORY_BYTES:-536870912}"

if [[ ! "$min_disk" =~ ^[0-9]+$ || ! "$min_inodes" =~ ^[0-9]+$ || ! "$min_mem" =~ ^[0-9]+$ ]]; then
  echo "status=blocked reason=invalid_threshold"
  exit 1
fi

existing_dir() {
  local dir="$1"
  while [[ ! -e "$dir" ]]; do
    local parent
    parent="$(dirname "$dir")"
    if [[ "$parent" == "$dir" ]]; then
      printf '%s\n' "/"
      return
    fi
    dir="$parent"
  done
  printf '%s\n' "$dir"
}

blocked=0

report_disk() {
  local label="$1"
  local configured="$2"
  local dir free inodes
  dir="$(existing_dir "$configured")"
  free="$(df -P -B1 "$dir" | awk 'NR==2 { print $4 }')"
  inodes="$(df -P -i "$dir" | awk 'NR==2 { print $4 }')"
  if [[ ! "$free" =~ ^[0-9]+$ || ! "$inodes" =~ ^[0-9]+$ ]]; then
    printf '%s=%s free_bytes=unreadable free_inodes=unreadable\n' "$label" "$configured"
    blocked=1
    return
  fi
  printf '%s=%s free_bytes=%s free_inodes=%s\n' "$label" "$configured" "$free" "$inodes"
  if [[ "$free" -lt "$min_disk" || "$inodes" -lt "$min_inodes" ]]; then
    blocked=1
  fi
}

report_disk "worktree_root" "$worktree_root"
report_disk "docker_data_root" "$docker_root"

mem=0
if [[ -r /proc/meminfo ]]; then
  # BusyBox/mawk may print scientific notation for large products; force integer.
  mem="$(awk '/^MemAvailable:/ { printf "%d\n", $2 * 1024 }' /proc/meminfo)"
fi
if [[ ! "$mem" =~ ^[0-9]+$ ]]; then
  mem=0
fi
printf 'memory_available_bytes=%s\n' "$mem"
printf 'min_free_disk_bytes=%s\n' "$min_disk"
printf 'min_free_inodes=%s\n' "$min_inodes"
printf 'min_available_memory_bytes=%s\n' "$min_mem"
if [[ "$mem" -lt "$min_mem" ]]; then
  blocked=1
fi

if [[ "$blocked" -eq 1 ]]; then
  echo "status=blocked"
  exit 1
fi
echo "status=ok"
exit 0
