import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REQUIRED_KEYS = [
  "MODEL_API_KEY",
  "MODEL_ENDPOINT",
  "OPTIO_NEW_ENV",
  "OPTIO_NEW_POSTGRES_USER",
  "OPTIO_NEW_POSTGRES_PASSWORD",
  "OPTIO_NEW_POSTGRES_DB",
  "OPTIO_NEW_DATABASE_URL",
  "OPTIO_NEW_REDIS_URL",
  "OPTIO_NEW_JEV_BASE_URL",
  "OPTIO_NEW_JEV_API_KEY",
  "OPTIO_NEW_LAYA_URL",
  "LITELLM_MASTER_KEY",
  "LITELLM_BASE_URL",
  "KIT_HARNESS_PORT",
  "OPTIO_NEW_HARNESS_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPTIO_NEW_INTAKE_WEBHOOK_SECRET",
  "OPTIO_NEW_GITHUB_WEBHOOK_SECRET",
  "OPTIO_NEW_GITHUB_TOKEN",
  "CURSOR_API_KEY",
  "OPTIO_NEW_BACKUP_MODE",
  "OPTIO_NEW_BACKUP_REPO",
  "OPTIO_NEW_BACKUP_PASSWORD",
  "OPTIO_NEW_BACKUP_SSH_HOST",
  "OPTIO_NEW_BACKUP_SSH_USER",
  "OPTIO_NEW_BACKUP_SSH_PORT",
  "OPTIO_NEW_BACKUP_SSH_KEY_PATH",
  "OPTIO_NEW_BACKUP_SSH_KNOWN_HOSTS",
  "OPTIO_NEW_BACKUP_REMOTE_DIR",
  "OPTIO_NEW_BACKUP_SFTP_COMMAND",
  "OPTIO_NEW_BACKUP_BORG_REMOTE_PATH",
  "OPTIO_NEW_BACKUP_KEEP_DAILY",
  "OPTIO_NEW_BACKUP_KEEP_WEEKLY",
  "OPTIO_NEW_BACKUP_KEEP_MONTHLY",
  "OPTIO_NEW_BACKUP_ALERT_WEBHOOK",
  "CAVEMAN_PROXY_ENABLED",
];

function assignmentKeys(path: string): string[] {
  const keys: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) keys.push(trimmed.slice(0, eq));
  }
  return keys;
}

describe("secrets management", () => {
  it("keeps root and secrets env templates aligned", () => {
    const root = assignmentKeys(".env.example");
    const secrets = assignmentKeys("secrets/.env.example");
    for (const key of REQUIRED_KEYS) {
      expect(root, key).toContain(key);
      expect(secrets, key).toContain(key);
    }
    expect([...root].sort()).toEqual([...secrets].sort());
  });

  it("audits gitignore and tracked files without printing values", () => {
    const out = execFileSync("bash", ["scripts/secrets.sh", "audit"], {
      encoding: "utf8",
    });
    expect(out).toContain("[secrets] PASS audit");
    expect(out).not.toContain("changeme");
    expect(out).not.toContain("sk-change-me");
    const agePrivateKeyPrefix = "AGE-SECRET-KEY-";
    expect(out).not.toContain(`${agePrivateKeyPrefix}1`);
  });

  it("loads Compose from the helper instead of a systemd EnvironmentFile", () => {
    for (const path of [
      "deploy/systemd/optio-new-compose.service",
      "deploy/systemd/agent-harness-compose.service",
    ]) {
      const unit = readFileSync(path, "utf8");
      expect(unit).toContain("/opt/optio-new/scripts/secrets.sh compose up -d");
      expect(unit).toContain("SOPS_AGE_KEY_FILE=/opt/optio-new/secrets/age/key.txt");
      expect(unit).not.toMatch(/^\s*EnvironmentFile=/m);
    }
  });

  it("does not put secret values in the CI workflow", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).not.toContain("ACTIONS_STEP_DEBUG");
    expect(workflow).not.toContain("OPTIO_NEW_POSTGRES_PASSWORD");
    expect(workflow).not.toContain("LITELLM_MASTER_KEY");
    expect(workflow).not.toContain("MODEL_API_KEY");
  });
});
