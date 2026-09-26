#!/usr/bin/env bash
# Decide keep/drop for Storage Box dump names optio-new-pg-YYYYMMDDTHHMMSSZ.sql.gz.
# Usage: storagebox-retention.sh <now-epoch-seconds>
# Stdin: one basename per line.
# Stdout: "keep <name>" | "drop <name>" | "skip <name>"
# Policy matches restic/borg --keep-daily/weekly/monthly: the newest dump in each
# UTC day, ISO week, and month, inside the window. A name is kept if any tier keeps it.
# Env: OPTIO_NEW_BACKUP_KEEP_DAILY (7), KEEP_WEEKLY (4), KEEP_MONTHLY (6).
set -euo pipefail

now="${1:-}"
if [[ ! "$now" =~ ^[0-9]+$ ]]; then
  echo "storagebox-retention: now epoch required" >&2
  exit 1
fi

keep_daily="${OPTIO_NEW_BACKUP_KEEP_DAILY:-7}"
keep_weekly="${OPTIO_NEW_BACKUP_KEEP_WEEKLY:-4}"
keep_monthly="${OPTIO_NEW_BACKUP_KEEP_MONTHLY:-6}"
for name in OPTIO_NEW_BACKUP_KEEP_DAILY OPTIO_NEW_BACKUP_KEEP_WEEKLY OPTIO_NEW_BACKUP_KEEP_MONTHLY; do
  value="${!name:-}"
  if [[ "$name" == OPTIO_NEW_BACKUP_KEEP_DAILY ]]; then value="$keep_daily"; fi
  if [[ "$name" == OPTIO_NEW_BACKUP_KEEP_WEEKLY ]]; then value="$keep_weekly"; fi
  if [[ "$name" == OPTIO_NEW_BACKUP_KEEP_MONTHLY ]]; then value="$keep_monthly"; fi
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "storagebox-retention: ${name} must be a positive integer" >&2
    exit 1
  fi
done

today="$(date -u -d "@${now}" +%Y-%m-%d)"
daily_cutoff="$(date -u -d "${today} -$((keep_daily - 1)) days" +%s)"
weekly_anchor="$(date -u -d "${today} -$(((keep_weekly - 1) * 7)) days" +%Y-%m-%d)"
weekly_dow="$(date -u -d "$weekly_anchor" +%u)"
weekly_cutoff="$(date -u -d "${weekly_anchor} -$((weekly_dow - 1)) days" +%s)"
monthly_cutoff="$(date -u -d "${today} -$((keep_monthly - 1)) months" +%Y-%m-01)"
monthly_cutoff_epoch="$(date -u -d "$monthly_cutoff" +%s)"

declare -A best_epoch_for_day=()
declare -A best_name_for_day=()
declare -A epoch_of=()
declare -a order=()

while IFS= read -r name || [[ -n "$name" ]]; do
  name="${name%$'\r'}"
  [[ -z "$name" ]] && continue
  if [[ ! "$name" =~ ^optio-new-pg-([0-9]{8})T([0-9]{6})Z\.sql\.gz$ ]]; then
    printf 'skip %s\n' "$name"
    continue
  fi
  ymd="${BASH_REMATCH[1]}"
  hms="${BASH_REMATCH[2]}"
  iso="${ymd:0:4}-${ymd:4:2}-${ymd:6:2}T${hms:0:2}:${hms:2:2}:${hms:4:2}Z"
  if ! epoch="$(date -u -d "$iso" +%s 2>/dev/null)"; then
    printf 'skip %s\n' "$name"
    continue
  fi
  epoch_of["$name"]="$epoch"
  order+=("$name")
  prev="${best_epoch_for_day[$ymd]:-}"
  if [[ -z "$prev" || "$epoch" -gt "$prev" ]]; then
    best_epoch_for_day["$ymd"]="$epoch"
    best_name_for_day["$ymd"]="$name"
  fi
done

declare -A best_epoch_for_week=()
declare -A best_name_for_week=()
declare -A best_epoch_for_month=()
declare -A best_name_for_month=()

if [[ ${#best_name_for_day[@]} -gt 0 ]]; then
  for day in "${!best_name_for_day[@]}"; do
    name="${best_name_for_day[$day]}"
    epoch="${epoch_of[$name]}"
    week="$(date -u -d "@${epoch}" +%G-W%V)"
    month="$(date -u -d "@${epoch}" +%Y-%m)"
    if [[ -z "${best_epoch_for_week[$week]:-}" || "$epoch" -gt "${best_epoch_for_week[$week]}" ]]; then
      best_epoch_for_week["$week"]="$epoch"
      best_name_for_week["$week"]="$name"
    fi
    if [[ -z "${best_epoch_for_month[$month]:-}" || "$epoch" -gt "${best_epoch_for_month[$month]}" ]]; then
      best_epoch_for_month["$month"]="$epoch"
      best_name_for_month["$month"]="$name"
    fi
  done
fi

declare -A keep=()

if [[ ${#best_name_for_day[@]} -gt 0 ]]; then
  for day in "${!best_name_for_day[@]}"; do
    name="${best_name_for_day[$day]}"
    epoch="${epoch_of[$name]}"
    day_start="$(date -u -d "${day:0:4}-${day:4:2}-${day:6:2}" +%s)"
    if [[ "$day_start" -ge "$daily_cutoff" && "$epoch" -le "$now" ]]; then
      keep["$name"]=1
    fi
  done
fi

if [[ ${#best_name_for_week[@]} -gt 0 ]]; then
  for week in "${!best_name_for_week[@]}"; do
    name="${best_name_for_week[$week]}"
    epoch="${epoch_of[$name]}"
    [[ "$epoch" -le "$now" ]] || continue
    dow="$(date -u -d "@${epoch}" +%u)"
    day_midnight="$(date -u -d "@${epoch}" +%Y-%m-%d)"
    week_start="$(date -u -d "${day_midnight} -$((dow - 1)) days" +%Y-%m-%d)"
    week_start_epoch="$(date -u -d "$week_start" +%s)"
    if [[ "$week_start_epoch" -ge "$weekly_cutoff" ]]; then
      keep["$name"]=1
    fi
  done
fi

if [[ ${#best_name_for_month[@]} -gt 0 ]]; then
  for month in "${!best_name_for_month[@]}"; do
    name="${best_name_for_month[$month]}"
    epoch="${epoch_of[$name]}"
    [[ "$epoch" -le "$now" ]] || continue
    month_start="$(date -u -d "@${epoch}" +%Y-%m-01)"
    month_start_epoch="$(date -u -d "$month_start" +%s)"
    if [[ "$month_start_epoch" -ge "$monthly_cutoff_epoch" ]]; then
      keep["$name"]=1
    fi
  done
fi

if [[ ${#order[@]} -eq 0 ]]; then
  exit 0
fi

for name in "${order[@]}"; do
  if [[ -n "${keep[$name]:-}" ]]; then
    printf 'keep %s\n' "$name"
  else
    printf 'drop %s\n' "$name"
  fi
done
