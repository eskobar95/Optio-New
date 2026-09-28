/**
 * Standalone catalog API process (ENG-23).
 * Orchestrator may also start this via startOptioApiFromEnv when OPTIO_NEW_API_ENABLED=1.
 */
import { startOptioApiFromEnv } from "./http.js";

const started = await startOptioApiFromEnv();
console.log(
  JSON.stringify({
    msg: "optio-api listening",
    host: started.host,
    port: started.port,
  }),
);

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ msg: "optio-api stopping", signal }));
  started.server.close();
  await started.db.close();
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
