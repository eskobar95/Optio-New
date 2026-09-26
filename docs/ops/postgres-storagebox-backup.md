# Postgres backups to Hetzner Storage Box

SPEC §12.5. Dumps go to a Storage Box on a schedule. Secrets stay in sops (or, later, Infisical). Nothing in this runbook is a credential.

## What runs

`scripts/backup-postgres-to-storagebox.sh` runs `pg_dump --no-owner --no-privileges`, gzips the SQL, then stores it:

| `OPTIO_NEW_BACKUP_MODE` | Store                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| `auto` (default)        | `restic` if it is on `PATH`, otherwise `borg`                                  |
| `restic`                | restic repository over SFTP. Snapshots are tagged `optio-new` and `postgres`.  |
| `borg`                  | Borg repository over SSH. Archive names are `optio-new-pg-<UTC stamp>`.        |
| `sftp`                  | One gzip file uploaded with SFTP. Listing uses `rsync` over the same SSH port. |
| `rsync`                 | One gzip file uploaded with `rsync`.                                           |

`auto` does not fall through to `sftp` or `rsync`. Set the mode when you want a plain file instead of restic or borg.

Storage Box SSH for rsync, Borg, and SFTP is **port 23**. Enable SSH support and external reachability on the box in the Hetzner console. Port 22 is SFTP/SCP only and expects a different public-key format; do not point these scripts at port 22.

## Secrets

The kit-harness host uses **sops + age**. Infisical is not installed. Both use the same key names from `.env.example`. See [docs/secrets.md](../secrets.md).

Put backup values in the host env, then encrypt:

```bash
bash scripts/secrets.sh encrypt --force
bash scripts/secrets.sh check
```

| Name                                | Role                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- |
| `OPTIO_NEW_DATABASE_URL`            | `pg_dump` connection string. Already used by Compose.                |
| `OPTIO_NEW_BACKUP_MODE`             | `auto`, `restic`, `borg`, `sftp`, or `rsync`.                        |
| `OPTIO_NEW_BACKUP_REPO`             | restic or borg repository URL. Empty for `sftp` and `rsync`.         |
| `OPTIO_NEW_BACKUP_PASSWORD`         | restic password or borg passphrase. Empty for `sftp` and `rsync`.    |
| `OPTIO_NEW_BACKUP_SSH_HOST`         | `uXXXXX.your-storagebox.de`                                          |
| `OPTIO_NEW_BACKUP_SSH_USER`         | `uXXXXX` or a sub-account such as `uXXXXX-sub1`                      |
| `OPTIO_NEW_BACKUP_SSH_PORT`         | `23`                                                                 |
| `OPTIO_NEW_BACKUP_SSH_KEY_PATH`     | Private key path. Default on the host: `secrets/storagebox_ed25519`. |
| `OPTIO_NEW_BACKUP_SSH_KNOWN_HOSTS`  | Optional `known_hosts` file.                                         |
| `OPTIO_NEW_BACKUP_REMOTE_DIR`       | Relative directory for `sftp` and `rsync`.                           |
| `OPTIO_NEW_BACKUP_SFTP_COMMAND`     | Optional restic SFTP command when SSH config does not set port 23.   |
| `OPTIO_NEW_BACKUP_BORG_REMOTE_PATH` | Optional, usually `borg-1.4` on a Storage Box.                       |
| `OPTIO_NEW_BACKUP_KEEP_*`           | Retention counts below.                                              |
| `OPTIO_NEW_BACKUP_ALERT_WEBHOOK`    | Optional `http(s)` URL. The URL is a secret.                         |

The SSH private key is a file, mode `0600`, gitignored as `secrets/storagebox_*`. Paste only the public key into the Storage Box. Do not put the private key in the env file.

Cron and systemd call `scripts/secrets.sh run`. That decrypts `secrets/optio-new.env` to a `0600` file on tmpfs, exports it, runs the dump, and deletes the file. Do not add `EnvironmentFile` to the unit. `systemctl show` would print the values.

If you later adopt Infisical, keep these names and change `ExecStart` to `infisical run --env=prod -- /opt/optio-new/scripts/backup-postgres-to-storagebox.sh`. The token stays off git. Until then, do not run an Infisical agent on this VPS.

## SSH

```bash
install -m 0700 -d /opt/optio-new/secrets
# write the private key to secrets/storagebox_ed25519, then:
chmod 0600 /opt/optio-new/secrets/storagebox_ed25519
ssh-keyscan -p 23 uXXXXX.your-storagebox.de >> /opt/optio-new/secrets/storagebox_known_hosts
```

Pin that host key. Set `OPTIO_NEW_BACKUP_SSH_KNOWN_HOSTS=/opt/optio-new/secrets/storagebox_known_hosts` in the encrypted env. The scripts set `StrictHostKeyChecking=yes` and `BatchMode=yes`, so a missing known host fails the job instead of prompting.

For restic, port 23 has to be in SSH config or in `OPTIO_NEW_BACKUP_SFTP_COMMAND`. Example SSH config (placeholders):

```text
Host storagebox
  HostName uXXXXX.your-storagebox.de
  User uXXXXX
  Port 23
  IdentityFile /opt/optio-new/secrets/storagebox_ed25519
  IdentitiesOnly yes
```

Repository URL with that alias: `sftp:storagebox:backups/optio-new`.

Borg URL: `ssh://uXXXXX@uXXXXX.your-storagebox.de:23/./backups/optio-new`.

Set `OPTIO_NEW_BACKUP_BORG_REMOTE_PATH=borg-1.4` so the box uses its Borg 1.4 binary.

## Retention

Default window: **7 daily, 4 weekly, 6 monthly**. Override with `OPTIO_NEW_BACKUP_KEEP_DAILY`, `OPTIO_NEW_BACKUP_KEEP_WEEKLY`, and `OPTIO_NEW_BACKUP_KEEP_MONTHLY`. Counts must be positive integers.

restic forget groups by host and tags, so a new dump path does not keep every snapshot. Borg prunes only archives named `optio-new-pg-*`. Plain `sftp` and `rsync` uploads use the same window on filenames `optio-new-pg-<UTC stamp>.sql.gz`: the newest file in each UTC day, ISO week, and calendar month inside the window is kept, and the union of those names is what remains. Same-day extras are deleted. Names that do not match the pattern are left alone.

Do not enable Borg append-only on this repo. Retention deletes old archives. Append-only would make prune fail.

## Schedule

Install the timer **or** the cron file, not both.

```bash
sudo cp deploy/systemd/optio-new-postgres-backup.service /etc/systemd/system/
sudo cp deploy/systemd/optio-new-postgres-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now optio-new-postgres-backup.timer
systemctl list-timers optio-new-postgres-backup.timer
```

The timer fires at 03:15 in the host timezone. Keep the VPS in UTC. `Persistent=true` runs a missed dump after downtime.

Cron file: `deploy/cron/optio-new-postgres-backup` → `/etc/cron.d/optio-new-postgres-backup`. It also calls `scripts/secrets.sh run`. It contains no secret values.

Manual run:

```bash
SOPS_AGE_KEY_FILE=/opt/optio-new/secrets/age/key.txt \
  bash scripts/secrets.sh run bash scripts/backup-postgres-to-storagebox.sh
```

## First upload

restic and borg need a repository before the timer runs. From `/opt/optio-new`, with the encrypted env in place:

```bash
bash scripts/secrets.sh run bash -c \
  'export RESTIC_REPOSITORY="$OPTIO_NEW_BACKUP_REPO" RESTIC_PASSWORD="$OPTIO_NEW_BACKUP_PASSWORD"
   restic init'
```

```bash
bash scripts/secrets.sh run bash -c \
  'export BORG_PASSPHRASE="$OPTIO_NEW_BACKUP_PASSWORD"
   borg init --encryption=repokey --remote-path borg-1.4 "$OPTIO_NEW_BACKUP_REPO"'
```

Drop `--remote-path borg-1.4` only if the box should use its default Borg binary. The passphrase stays in the environment; it is not an argument.

`sftp` and `rsync` create `OPTIO_NEW_BACKUP_REMOTE_DIR` on first upload. The `pg_dump` client major version should match the server.

## Alert on failure

A failed dump exits non-zero. The script writes to stderr and, when `logger` exists, to the syslog tag `optio-new-backup`. systemd records the oneshot as failed:

```bash
systemctl status optio-new-postgres-backup.service
journalctl -u optio-new-postgres-backup.service
```

If `OPTIO_NEW_BACKUP_ALERT_WEBHOOK` is set, the script also POSTs JSON `{"text","content","exit_code",...}` with a 15s timeout. `text` matches Slack incoming webhooks. `content` matches Discord. The body does not include the database URL, the backup password, or the webhook URL. If the variable is empty, the non-zero exit and the journal are the alert.

## Restore dry-run

The dry-run proves the latest archive can be read. It does not open a database connection and it does not run `psql`.

```bash
SOPS_AGE_KEY_FILE=/opt/optio-new/secrets/age/key.txt \
  bash scripts/secrets.sh run bash scripts/restore-postgres-storagebox-dry-run.sh
```

Success prints `restore dry-run passed` and `database was not modified`. The script:

1. Loads secrets through `secrets.sh run` (or the environment, if you already exported it).
2. Fetches the latest restic snapshot, borg archive, or `optio-new-pg-*.sql.gz` into a `0600` temp directory.
3. Runs `gzip -t`.
4. Checks that the plaintext starts with a `pg_dump` header (`PostgreSQL database dump`).
5. Deletes the temp directory.

Run this after the first real backup, and again when you want a drill. A non-zero exit means the latest copy failed the check. The dry-run does not call the alert webhook; the backup timer does.

There is no scheduled restore. A dry-run on an empty repository fails until the first backup exists.

## Manual restore

This is not the dry-run. It writes SQL into a database.

Stop writers first (`scripts/secrets.sh compose stop` on the workers, or stop the whole stack). Take a fresh backup before you replace data.

Prefer a scratch database. Point `psql` at that URL, not at the production `OPTIO_NEW_DATABASE_URL`, until the row counts look right.

```bash
# After the dry-run has already shown which stamp is newest:
gzip -dc /path/to/optio-new-pg-YYYYMMDDTHHMMSSZ.sql.gz | psql "$SCRATCH_DATABASE_URL"
```

For restic, write the stable name to a file you control, then load the scratch database:

```bash
bash scripts/secrets.sh run bash -c \
  'export RESTIC_REPOSITORY="$OPTIO_NEW_BACKUP_REPO" RESTIC_PASSWORD="$OPTIO_NEW_BACKUP_PASSWORD"
   restic dump --tag optio-new --tag postgres --host optio-new latest optio-new-postgres.sql.gz > /dev/shm/optio-new-restore.sql.gz'
gzip -dc /dev/shm/optio-new-restore.sql.gz | psql "$SCRATCH_DATABASE_URL"
shred -u /dev/shm/optio-new-restore.sql.gz
```

Drop the scratch database when the drill is done. Only point `psql` at production after that check, with writers still stopped. Start the stack again with `scripts/secrets.sh compose up -d`.

## What this does not do

- It does not restore into Postgres by itself.
- It does not store the age key or the Storage Box key in git.
- It does not page anyone unless `OPTIO_NEW_BACKUP_ALERT_WEBHOOK` is set. The systemd failure is still visible.
