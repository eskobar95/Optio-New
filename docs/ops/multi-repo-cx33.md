# Multi-repo checkouts on a CX33

One factory can route a task to more than one git remote. The orchestrator does not fork. `repoId` selects a binding:

| Field           | Role                                                     |
| --------------- | -------------------------------------------------------- |
| `repoId`        | Safe token (`[A-Za-z0-9][A-Za-z0-9._-]*`). No `:`.       |
| `cloneUrl`      | Git remote. Used to match GitHub `repository.clone_url`. |
| `localPath`     | Existing checkout the worktree is registered on.         |
| `defaultBranch` | Branch new task branches are cut from.                   |
| `worktreeRoot`  | Directory that holds `wt-<task>` for this repo.          |

`OPTIO_NEW_REPOS` is a JSON array of those objects. When it is empty, the catalog is one default repo: `OPTIO_NEW_DEFAULT_REPO_ID` (else `default`), `OPTIO_NEW_REPO_PATH` (else `/opt/optio-new`), `OPTIO_NEW_WORKTREE_ROOT`, `OPTIO_NEW_BASE_BRANCH`, and a clone URL from `OPTIO_NEW_REPO_CLONE_URL` or `https://github.com/<OPTIO_NEW_GITHUB_REPO>.git`.

Intake `metadata.repoId` is optional. Resolution order: task selector, then workflow `repo_id` in `workflows/default-task.yaml`, then the catalog default. An unknown id returns `400` `unknown_repo` and does not enqueue.

`RepoWorktreeRouter` creates and reaps under that binding's `worktreeRoot` and `localPath`. Give each repo its own `worktreeRoot`, as a subdirectory of `/var/lib/optio-new/worktrees`, so locks do not collide.

## Disk on a Hetzner CX33

A CX33 is about 8 GB RAM and 80 GB disk. Git worktrees share objects with their `localPath`. They do not share objects across repos. N repos means N clones plus N working trees (and, if you install dependencies in each tree, N `node_modules`).

Budget before `git worktree add`:

- Keep at least 2 GiB free on the worktree filesystem and on the Docker data root (`ResourceGuard`, `scripts/resource-usage.sh`).
- Plan roughly one clone plus one working tree per extra repo, not one clone per task.
- Mount every `localPath` into the orchestrator container. The Compose file mounts `/opt/optio-new` only. A second repo needs its own volume line.
- Docker images, Postgres, and agent artifacts sit on the same small disk. The guard checks the Docker data root as well as the worktree root.

The in-process probe measures an existing ancestor when the directory is not created yet. Point `worktreeRoot` and `OPTIO_NEW_DOCKER_DATA_ROOT` at the filesystem you mean so a full volume is not hidden behind `/`.
