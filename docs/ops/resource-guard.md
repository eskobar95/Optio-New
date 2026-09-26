# CX33 disk and memory guard

kit-harness hosts are small. `ResourceGuard` runs before a new git worktree is added and fails closed when free disk, free inodes, or available memory is under the threshold. The task status record is `code: "resource_guard"`, `status: "blocked"`, and a `ResourceGuard:` message with paths and byte counts. That message is also the thrown error (BullMQ job failure). It does not contain secrets.

A later check that passes records `status: "clear"`.

## Thresholds

| Variable                               | Default                        | Meaning                                       |
| -------------------------------------- | ------------------------------ | --------------------------------------------- |
| `OPTIO_NEW_MIN_FREE_DISK_BYTES`        | `2147483648`                   | 2 GiB free on the worktree root and on Docker |
| `OPTIO_NEW_MIN_FREE_INODES`            | `10000`                        | Free inodes on those same paths               |
| `OPTIO_NEW_MIN_AVAILABLE_MEMORY_BYTES` | `536870912`                    | 512 MiB `MemAvailable`                        |
| `OPTIO_NEW_DOCKER_DATA_ROOT`           | `/var/lib/docker`              | Docker data root                              |
| `OPTIO_NEW_WORKTREE_ROOT`              | `/var/lib/optio-new/worktrees` | Default checkout's worktree parent            |

Invalid (non-integer) values throw at startup. The orchestrator wires this through `createGuardedRepoWorktrees`.

## Ops report

On the host, cron can run:

```bash
bash scripts/resource-usage.sh
```

Stdout is paths and counts (`worktree_root`, `docker_data_root`, `memory_available_bytes`, the thresholds, `status=ok` or `status=blocked`). Exit `1` when blocked. The script does not print secret env values. Do not wrap it in a command that dumps the environment.

See also [multi-repo-cx33.md](multi-repo-cx33.md) for what N clones cost on this box.
