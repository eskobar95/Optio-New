import type { JevRouter, RoutingDecision, RoutingState } from "../../types.js";

/**
 * Laya local decision service (optional Compose profile `laya`, port 8000 loopback).
 * See docker-compose.yml profile laya.
 */
export const layaRouter: JevRouter = {
  async decide(_state: RoutingState): Promise<RoutingDecision> {
    const base = process.env.OPTIO_NEW_LAYA_URL || process.env.LAYA_URL || "http://127.0.0.1:8000";
    void base;
    throw new Error(`gateway/jev-router/plugins/laya: stub (base=${base})`);
  },
};

export default layaRouter;
