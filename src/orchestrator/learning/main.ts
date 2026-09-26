/**
 * Compose entry for the learning worker. Requires Redis and Postgres.
 * GitHub filing stays off unless OPTIO_LEARN_FILE_GITHUB=1.
 */
import { createMetaIssuePublisherFromEnv } from "./publisher.js";
import { readLearningConfig } from "./process.js";
import { createPgLearningStore } from "./store.js";
import { bullmqLearningWorkerFactory, startLearningWorker } from "./worker.js";

const redisUrl = process.env.OPTIO_NEW_REDIS_URL;
const databaseUrl = process.env.OPTIO_NEW_DATABASE_URL;

if (!redisUrl || !databaseUrl) {
  console.error(
    JSON.stringify({
      service: "learning-worker",
      event: "missing_env",
      need: ["OPTIO_NEW_REDIS_URL", "OPTIO_NEW_DATABASE_URL"],
    }),
  );
  process.exit(1);
}

const store = await createPgLearningStore(databaseUrl);
const config = readLearningConfig();
const handle = startLearningWorker(
  {
    store,
    publisher: createMetaIssuePublisherFromEnv(),
    threshold: config.threshold,
    windowDays: config.windowDays,
  },
  bullmqLearningWorkerFactory({ url: redisUrl, maxRetriesPerRequest: null }),
);

console.log(
  JSON.stringify({
    service: "learning-worker",
    event: "listen",
    queue: "optio.learn",
    threshold: config.threshold,
    windowDays: config.windowDays,
    fileGithub: process.env.OPTIO_LEARN_FILE_GITHUB === "1",
  }),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void handle
      .close()
      .then(() => store.close())
      .then(() => process.exit(0));
  });
}
