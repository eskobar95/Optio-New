import path from "node:path";

const ENV_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);

const SECRET_BASENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ed25519",
  "id_ecdsa",
  "credentials.json",
  "service-account.json",
]);

const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

/** Docs and examples under secrets/ are readable. Everything else there is key material. */
const SECRETS_DIR_ALLOW = new Set([
  "README.md",
  ".env.example",
  ".env.sample",
  ".env.template",
  ".sops.yaml.example",
  ".gitignore",
]);

const COMMAND_SPLIT = /[\s"'`=;|&<>()$]+/;

export interface ClassifiedPath {
  escaped: boolean;
  relative: string;
}

export function classifyPath(inputPath: string, worktreeRoot?: string): ClassifiedPath {
  const raw = inputPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!worktreeRoot) {
    return { escaped: raw.split("/").includes(".."), relative: raw };
  }

  const root = path.resolve(worktreeRoot);
  const absolute = path.resolve(root, inputPath);
  const rel = path.relative(root, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { escaped: true, relative: raw };
  }
  return { escaped: false, relative: rel.split(path.sep).join("/") };
}

function basename(relativePath: string): string {
  const parts = relativePath.split("/");
  return parts[parts.length - 1] ?? relativePath;
}

export function isSecretRelativePath(relativePath: string): boolean {
  const base = basename(relativePath);
  if (base === ".env" || (base.startsWith(".env.") && !ENV_EXAMPLES.has(base))) {
    return true;
  }
  if (SECRET_BASENAMES.has(base)) return true;
  if (SECRET_EXTENSIONS.has(path.posix.extname(base).toLowerCase())) return true;
  if (relativePath === "secrets" || relativePath.startsWith("secrets/")) {
    return !SECRETS_DIR_ALLOW.has(base);
  }
  return false;
}

export function isLockedConfigPath(relativePath: string): boolean {
  const base = basename(relativePath);
  if (base === "AGENTS.md") return true;
  if (base === "harness.config" || base.startsWith("harness.config.")) return true;
  if (
    relativePath === "workflows" ||
    (relativePath.startsWith("workflows/") &&
      (relativePath.endsWith(".yaml") || relativePath.endsWith(".yml")))
  ) {
    return true;
  }
  if (relativePath === ".cursor" || relativePath.startsWith(".cursor/")) return true;
  if (relativePath === "skills/index.json" || relativePath === "specialists/index.json") {
    return true;
  }
  return false;
}

function commandTokens(command: string): string[] {
  return command
    .split(COMMAND_SPLIT)
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/^\.\//, ""));
}

export function commandReferencesSecret(command: string): boolean {
  return matchedSecretToken(command) !== undefined;
}

export function matchedSecretToken(command: string): string | undefined {
  return commandTokens(command).find((token) => isSecretRelativePath(token));
}

export function matchedLockedConfigToken(command: string): string | undefined {
  return commandTokens(command).find((token) => isLockedConfigPath(token));
}

/** Exec that names a locked path and looks like a mutation. Plain reads stay on the read tool. */
const COMMAND_MUTATION = /(?:>>?|\b(?:tee|cp|mv|rm|truncate|sed|perl|python|node)\b)/;

export function commandMutatesLockedConfig(command: string): boolean {
  return matchedLockedConfigToken(command) !== undefined && COMMAND_MUTATION.test(command);
}
