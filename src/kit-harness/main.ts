/**
 * Process entry for Compose / `npm run kit-harness`.
 */
import { formatStageLog } from "./redact.js";
import { createKitHarnessServer, resolveListen } from "./server.js";

const { host, port } = resolveListen();
const server = createKitHarnessServer();

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(formatStageLog({ service: "kit-harness", event: "error", message: error.message }));
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

server.listen(port, host, () => {
  console.log(JSON.stringify({ service: "kit-harness", event: "listen", host, port }));
});
