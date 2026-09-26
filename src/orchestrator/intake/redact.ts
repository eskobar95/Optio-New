/**
 * Strip credential-shaped substrings before a message is logged or returned.
 * Callers still must not log raw webhook bodies or signature headers.
 */
const SECRET_PATTERNS = [
  /sha256=[0-9a-f]{16,}/gi,
  /v0=[0-9a-f]{16,}/gi,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /ghp_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /sk-[A-Za-z0-9]+/g,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted]"), text);
}
