/**
 * Stage log line. Every string is passed through the shared redactor before write.
 */
import { formatStageLog } from "../../security/redact.js";

export function logStageEvent(
  record: Record<string, unknown>,
  write: (line: string) => void = console.log,
): void {
  write(formatStageLog(record));
}
