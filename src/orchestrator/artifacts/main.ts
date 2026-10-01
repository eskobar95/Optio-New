/**
 * CLI entry: node dist/src/orchestrator/artifacts/main.js --task TASK [--session SESSION]
 * Reads OPTIO_NEW_DATABASE_URL. Prints the trail JSON. Does not print the URL.
 */
import { resolveTenantContext } from "../../config/tenant.js";
import { closeSharedPool, getSharedPool } from "../../db/pool.js";
import { openOrchestratorDatabase } from "../jobs/pg-state.js";
import { executeDumpCli } from "./cli.js";

const code = await executeDumpCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  openStore: async (databaseUrl) => {
    const database = await openOrchestratorDatabase(
      getSharedPool(databaseUrl),
      resolveTenantContext(process.env),
    );
    return { store: database.artifacts, close: () => closeSharedPool() };
  },
});
process.exit(code);
