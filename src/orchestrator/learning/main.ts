/**
 * Compose entry for the learning worker. Requires Redis and Postgres.
 * A threshold crossing opens a GitHub meta-issue when token and repo are set.
 * OPTIO_LEARN_FILE_GITHUB=0 stores the draft only.
 */
import { resolveTenantContext } from "../../config/tenant.js";
import { closeSharedPool, getSharedPool } from "../../db/pool.js";
import { createMetaIssuePublisherFromEnv, githubMetaIssuesEnabled } from "./publisher.js";
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

const store = await createPgLearningStore(
  getSharedPool(databaseUrl),
  resolveTenantContext(process.env),
);
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
    fileGithub: githubMetaIssuesEnabled(),
  }),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void handle
      .close()
      .then(() => closeSharedPool())
      .then(() => process.exit(0));
  });
}
