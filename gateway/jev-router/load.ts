import type { RouterDeps } from "./deps.js";
import { createJevRouter } from "./plugins/jev/index.js";
import { createLayaRouter } from "./plugins/laya/index.js";
import { poorjevRouter } from "./plugins/poorjev/index.js";
import { rulesRouter } from "./plugins/rules/index.js";
import type { JevRouter } from "./types.js";

export type Hop2PluginId = "jev" | "poorjev" | "laya" | "rules";

const PLUGIN_IDS: readonly Hop2PluginId[] = ["jev", "poorjev", "laya", "rules"];

function isPluginId(id: string): id is Hop2PluginId {
  return (PLUGIN_IDS as readonly string[]).includes(id);
}

/** Swap Hop 2 implementations without importing one from a CodingAgent adapter. */
export function loadHop2Router(id: string, deps: RouterDeps = {}): JevRouter {
  if (!isPluginId(id)) {
    throw new Error(`unknown JevRouter plugin: ${id}`);
  }
  switch (id) {
    case "jev":
      return createJevRouter(deps);
    case "laya":
      return createLayaRouter(deps);
    case "poorjev":
      return poorjevRouter;
    case "rules":
      return rulesRouter;
  }
}

/**
 * Read `OPTIO_NEW_JEV_ROUTER` (alias `JEV_ROUTER`).
 * Unset fails closed — there is no implicit plugin.
 */
export function loadConfiguredHop2Router(
  env: NodeJS.ProcessEnv = process.env,
  deps: RouterDeps = {},
): JevRouter {
  const raw = env.OPTIO_NEW_JEV_ROUTER || env.JEV_ROUTER || "";
  const id = raw.trim();
  if (!id) {
    throw new Error("OPTIO_NEW_JEV_ROUTER is unset");
  }
  return loadHop2Router(id, { ...deps, env: deps.env ?? env });
}
