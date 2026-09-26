import type { FetchLike } from "./systemone.js";

/** Injected env and fetch so plugin tests never call the network or process.env. */
export interface RouterDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}
