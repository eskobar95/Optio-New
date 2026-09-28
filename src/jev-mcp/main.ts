/**
 * CLI entry: stdio Jev MCP server for Cursor CLI mid-run soft gates (ENG-27).
 * stdout = MCP protocol; stderr = diagnostics.
 */
import { pathToFileURL } from "node:url";
import { createJevClient } from "../../gateway/jev-router/jev-client.js";
import { startJevMcpStdio } from "../../gateway/jev-router/mcp/index.js";
import { createOtelJevMcpTelemetry } from "./otel-telemetry.js";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const client = createJevClient({ env });
  const telemetry = createOtelJevMcpTelemetry();
  const handle = startJevMcpStdio({ client, telemetry, env });

  process.stderr.write(`jev-mcp listening on stdio (model=${client.model}, soft mid-run only)\n`);

  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await handle.closed;
}

const isDirectRun =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`jev-mcp failed: ${message}\n`);
    process.exit(1);
  });
}
