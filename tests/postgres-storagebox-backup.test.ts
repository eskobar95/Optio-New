import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function run(
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", args, {
      cwd: root,
      encoding: "utf8",
      input: options.input,
      env: options.env,
      timeout: 15000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

function scriptEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C",
    ...extra,
  };
}

describe("postgres storage box backup", () => {
  it("parses the backup, restore, and retention scripts", () => {
    for (const script of [
      "scripts/backup-postgres-to-storagebox.sh",
      "scripts/backup-postgres-to-storagebox.sh.example",
      "scripts/restore-postgres-storagebox-dry-run.sh",
      "scripts/lib/storagebox-retention.sh",
      "scripts/secrets.sh",
    ]) {
      const result = run(["-n", script]);
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("keeps the retention window and drops same-day extras", () => {
    const now = execFileSync("date", ["-u", "-d", "2026-09-26T12:00:00Z", "+%s"], {
      encoding: "utf8",
    }).trim();
    const names = [
      "optio-new-pg-20260926T030000Z.sql.gz",
      "optio-new-pg-20260926T010000Z.sql.gz",
      "optio-new-pg-20260920T030000Z.sql.gz",
      "optio-new-pg-20260919T030000Z.sql.gz",
      "optio-new-pg-20260914T030000Z.sql.gz",
      "optio-new-pg-20260913T030000Z.sql.gz",
      "optio-new-pg-20260907T030000Z.sql.gz",
      "optio-new-pg-20260901T030000Z.sql.gz",
      "notes.txt",
      "optio-new-pg-20260828T030000Z.sql.gz",
      "optio-new-pg-20260815T030000Z.sql.gz",
      "optio-new-pg-20260402T120000Z.sql.gz",
      "optio-new-pg-20260301T030000Z.sql.gz",
    ];
    const result = run(["scripts/lib/storagebox-retention.sh", now], {
      input: `${names.join("\n")}\n`,
      env: scriptEnv({
        OPTIO_NEW_BACKUP_KEEP_DAILY: "7",
        OPTIO_NEW_BACKUP_KEEP_WEEKLY: "4",
        OPTIO_NEW_BACKUP_KEEP_MONTHLY: "6",
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    const actions = new Map<string, string>();
    for (const line of result.stdout.trim().split("\n")) {
      const [action, name] = line.split(" ");
      expect(action).toMatch(/^(keep|drop|skip)$/);
      expect(actions.has(name ?? "")).toBe(false);
      actions.set(name ?? "", action ?? "");
    }
    expect(actions.get("optio-new-pg-20260926T030000Z.sql.gz")).toBe("keep");
    expect(actions.get("optio-new-pg-20260926T010000Z.sql.gz")).toBe("drop");
    expect(actions.get("optio-new-pg-20260920T030000Z.sql.gz")).toBe("keep");
    expect(actions.get("optio-new-pg-20260919T030000Z.sql.gz")).toBe("drop");
    expect(actions.get("optio-new-pg-20260914T030000Z.sql.gz")).toBe("drop");
    expect(actions.get("optio-new-pg-20260913T030000Z.sql.gz")).toBe("keep");
    expect(actions.get("optio-new-pg-20260907T030000Z.sql.gz")).toBe("drop");
    expect(actions.get("optio-new-pg-20260901T030000Z.sql.gz")).toBe("keep");
    expect(actions.get("optio-new-pg-20260828T030000Z.sql.gz")).toBe("keep");
    expect(actions.get("optio-new-pg-20260815T030000Z.sql.gz")).toBe("drop");
    expect(actions.get("optio-new-pg-20260402T120000Z.sql.gz")).toBe("keep");
    expect(actions.get("optio-new-pg-20260301T030000Z.sql.gz")).toBe("drop");
    expect(actions.get("notes.txt")).toBe("skip");
  });

  it("rejects a zero retention count", () => {
    const result = run(["scripts/lib/storagebox-retention.sh", "1700000000"], {
      input: "optio-new-pg-20260926T030000Z.sql.gz\n",
      env: scriptEnv({ OPTIO_NEW_BACKUP_KEEP_DAILY: "0" }),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("positive integer");
  });

  it("fails closed before pg_dump when configuration is missing", () => {
    const missingUrl = run(["scripts/backup-postgres-to-storagebox.sh"], {
      env: scriptEnv(),
    });
    expect(missingUrl.status).not.toBe(0);
    expect(missingUrl.stderr).toContain("OPTIO_NEW_DATABASE_URL");
    expect(`${missingUrl.stdout}${missingUrl.stderr}`).not.toContain("dumping postgres");

    const badMode = run(["scripts/backup-postgres-to-storagebox.sh"], {
      env: scriptEnv({
        OPTIO_NEW_DATABASE_URL: "postgres://optio:changeme@127.0.0.1:1/optio_new",
        OPTIO_NEW_BACKUP_MODE: "nope",
      }),
    });
    expect(badMode.status).not.toBe(0);
    expect(badMode.stderr).toContain("OPTIO_NEW_BACKUP_MODE");
    expect(`${badMode.stdout}${badMode.stderr}`).not.toContain("dumping postgres");

    const missingHost = run(["scripts/backup-postgres-to-storagebox.sh"], {
      env: scriptEnv({
        OPTIO_NEW_DATABASE_URL: "postgres://optio:changeme@127.0.0.1:1/optio_new",
        OPTIO_NEW_BACKUP_MODE: "sftp",
      }),
    });
    expect(missingHost.status).not.toBe(0);
    expect(missingHost.stderr).toContain("OPTIO_NEW_BACKUP_SSH_HOST");
    expect(`${missingHost.stdout}${missingHost.stderr}`).not.toContain("dumping postgres");
  });

  it("loads backup env through secrets.sh run without printing the value", () => {
    const work = mkdtempSync(path.join(tmpdir(), "optio-new-backup-"));
    const secret = "fixture-backup-secret";
    writeFileSync(
      path.join(work, ".env"),
      `OPTIO_NEW_BACKUP_PASSWORD=${secret}\nOPTIO_NEW_BACKUP_KEEP_DAILY=7\n`,
      { mode: 0o600 },
    );
    const env = scriptEnv({
      OPTIO_NEW_ROOT: work,
      OPTIO_NEW_ENV_FILE: path.join(work, ".env"),
      OPTIO_NEW_ENCRYPTED_ENV: path.join(work, "missing-cipher.env"),
    });
    const loaded = run(
      [
        "scripts/secrets.sh",
        "run",
        "bash",
        "-c",
        'test "$OPTIO_NEW_BACKUP_PASSWORD" = "$EXPECTED_SECRET" && test "$OPTIO_NEW_BACKUP_KEEP_DAILY" = 7 && echo loaded',
      ],
      { env: { ...env, EXPECTED_SECRET: secret } },
    );
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain("loaded");
    expect(loaded.stdout).not.toContain(secret);
    expect(loaded.stderr).not.toContain(secret);

    const failed = run(["scripts/secrets.sh", "run", "false"], { env });
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).not.toContain(secret);
    expect(failed.stderr).not.toContain(secret);
  });

  it("documents schedule, retention, dry-run, and sops without embedding secrets", () => {
    const doc = readFileSync("docs/ops/postgres-storagebox-backup.md", "utf8");
    for (const phrase of [
      "sops",
      "Infisical",
      "03:15",
      "7 daily, 4 weekly, 6 monthly",
      "restore dry-run passed",
      "database was not modified",
      "OPTIO_NEW_BACKUP_ALERT_WEBHOOK",
      "port 23",
      "sftp",
      "rsync",
      "EnvironmentFile",
      "secrets.sh run",
    ]) {
      expect(doc).toContain(phrase);
    }

    const unit = readFileSync("deploy/systemd/optio-new-postgres-backup.service", "utf8");
    expect(unit).toContain("scripts/secrets.sh run");
    expect(unit).not.toMatch(/^\s*EnvironmentFile=/m);
    expect(unit).toContain("SOPS_AGE_KEY_FILE=");

    const cron = readFileSync("deploy/cron/optio-new-postgres-backup", "utf8");
    expect(cron).toContain("scripts/secrets.sh run");
    expect(cron).not.toContain("OPTIO_NEW_BACKUP_PASSWORD=");

    const tracked = [
      "scripts/backup-postgres-to-storagebox.sh",
      "scripts/restore-postgres-storagebox-dry-run.sh",
      "scripts/lib/storagebox-common.sh",
      "scripts/lib/storagebox-retention.sh",
      "docs/ops/postgres-storagebox-backup.md",
      "deploy/systemd/optio-new-postgres-backup.service",
      "deploy/cron/optio-new-postgres-backup",
    ];
    const opensshMarker = ["BEGIN OPENSSH", "PRIVATE KEY"].join(" ");
    const rsaMarker = ["BEGIN RSA", "PRIVATE KEY"].join(" ");
    const ageMarker = ["AGE-SECRET-KEY-", "1"].join("");
    for (const file of tracked) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain(opensshMarker);
      expect(text).not.toContain(rsaMarker);
      expect(text).not.toContain(ageMarker);
      expect(text).not.toMatch(/u\d{5,}/);
      expect(text).not.toMatch(/OPTIO_NEW_BACKUP_PASSWORD=\S+/);
    }
  });
});
