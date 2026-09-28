/**
 * Process entry for Compose / local Flue stub sidecar.
 */
import { createFlueServer, resolveFlueListen } from "./server.js";

const { host, port } = resolveFlueListen();
const server = createFlueServer();

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(JSON.stringify({ service: "flue", event: "error", message: error.message }));
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

server.listen(port, host, () => {
  console.log(JSON.stringify({ service: "flue", event: "listen", host, port }));
});
