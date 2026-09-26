import { describe, it, expect } from "vitest";
import { loadCavemanProxyConfig, resolveCodexUpstreamBaseUrl } from "../src/proxy/index.js";

describe("caveman proxy config", () => {
  it("defaults to disabled", () => {
    const cfg = loadCavemanProxyConfig({});
    expect(cfg.enabled).toBe(false);
    expect(resolveCodexUpstreamBaseUrl(cfg, "http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
  });

  it("returns proxy url when enabled", () => {
    const cfg = loadCavemanProxyConfig({
      CAVEMAN_PROXY_ENABLED: "true",
      CAVEMAN_PROXY_URL: "http://127.0.0.1:8787/",
      CAVEMAN_MODE: "compress",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe("compress");
    expect(resolveCodexUpstreamBaseUrl(cfg)).toBe("http://127.0.0.1:8787");
  });
});
