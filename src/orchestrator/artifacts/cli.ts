/**
 * Dump a task's artifact trail as JSON.
 * Operators usually call scripts/dump-session-artifacts.sh (HTTP).
 * This entry reads Postgres when the orchestrator process is down.
 */
import { dumpSessionArtifactTrail } from "./trail.js";
import type { SessionArtifactStore } from "./store.js";

export interface DumpCliIo {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  store?: SessionArtifactStore;
  openStore?: (
    databaseUrl: string,
  ) => Promise<{ store: SessionArtifactStore; close(): Promise<void> }>;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export async function executeDumpCli(io: DumpCliIo): Promise<number> {
  const taskId = flag(io.argv, "--task");
  if (!taskId || taskId.includes(":")) {
    io.stderr("usage: dump-session-artifacts --task <taskId> [--session <sessionId>]");
    return 2;
  }
  const sessionId = flag(io.argv, "--session") ?? taskId;
  if (sessionId.includes(":")) {
    io.stderr("sessionId must not contain ':'");
    return 2;
  }

  let store = io.store;
  let close: (() => Promise<void>) | undefined;
  if (!store) {
    const databaseUrl = io.env.OPTIO_NEW_DATABASE_URL?.trim() ?? "";
    if (!databaseUrl || !io.openStore) {
      io.stderr("OPTIO_NEW_DATABASE_URL is required when no artifact store is injected");
      return 2;
    }
    const opened = await io.openStore(databaseUrl);
    store = opened.store;
    close = () => opened.close();
  }

  try {
    const trail = await dumpSessionArtifactTrail(store, taskId, sessionId);
    io.stdout(JSON.stringify(trail));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "artifact dump failed";
    io.stderr(message);
    return 1;
  } finally {
    await close?.();
  }
}
