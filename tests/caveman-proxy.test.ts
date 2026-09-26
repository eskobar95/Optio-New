import { describe, expect, it } from "vitest";
import { codexOpenAiBaseUrl } from "../src/adapters/codex/index.js";
import {
  litellmOrigin,
  loadCavemanProxyConfig,
  resolveCodexUpstreamBaseUrl,
} from "../src/proxy/index.js";

describe("caveman proxy config", () => {
  it("defaults to disabled and keeps Codex on local LiteLLM", () => {
    const cfg = loadCavemanProxyConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.url).toBe("http://127.0.0.1:8787");
    expect(cfg.mode).toBe("compress");
    expect(cfg.litellmBaseUrl).toBe("http://127.0.0.1:4000");
    expect(resolveCodexUpstreamBaseUrl(cfg)).toBe("http://127.0.0.1:4000/v1");
    expect(resolveCodexUpstreamBaseUrl(cfg, "http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(codexOpenAiBaseUrl({})).toBe("http://127.0.0.1:4000/v1");
  });

  it("treats only the string true as enabled", () => {
    expect(loadCavemanProxyConfig({ CAVEMAN_PROXY_ENABLED: " TRUE " }).enabled).toBe(true);
    expect(loadCavemanProxyConfig({ CAVEMAN_PROXY_ENABLED: "false" }).enabled).toBe(false);
    expect(loadCavemanProxyConfig({ CAVEMAN_PROXY_ENABLED: "1" }).enabled).toBe(false);
    expect(loadCavemanProxyConfig({ CAVEMAN_PROXY_ENABLED: "yes" }).enabled).toBe(false);
  });

  it("points Codex at the local LiteLLM compat mount when enabled", () => {
    const cfg = loadCavemanProxyConfig({
      CAVEMAN_PROXY_ENABLED: "true",
      CAVEMAN_PROXY_URL: "http://127.0.0.1:8787/",
      CAVEMAN_MODE: "compress",
      LITELLM_BASE_URL: "http://127.0.0.1:4000/v1",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe("compress");
    expect(cfg.url).toBe("http://127.0.0.1:8787");
    expect(cfg.litellmBaseUrl).toBe("http://127.0.0.1:4000");
    expect(litellmOrigin(cfg.litellmBaseUrl)).toBe("http://127.0.0.1:4000");
    expect(resolveCodexUpstreamBaseUrl(cfg, "http://127.0.0.1:4000/v1")).toBe(
      "http://127.0.0.1:8787/compat/litellm/v1",
    );
    expect(codexOpenAiBaseUrl({ CAVEMAN_PROXY_ENABLED: "true" })).toBe(
      "http://127.0.0.1:8787/compat/litellm/v1",
    );
  });

  it("does not double the compat path and accepts record mode", () => {
    const cfg = loadCavemanProxyConfig({
      CAVEMAN_PROXY_ENABLED: "true",
      CAVEMAN_PROXY_URL: "http://127.0.0.1:8787/compat/litellm/v1",
      CAVEMAN_MODE: "record",
    });
    expect(cfg.mode).toBe("record");
    expect(resolveCodexUpstreamBaseUrl(cfg)).toBe("http://127.0.0.1:8787/compat/litellm/v1");
  });

  it("falls back to compress for an unknown mode", () => {
    expect(loadCavemanProxyConfig({ CAVEMAN_MODE: "pixel" }).mode).toBe("compress");
  });

  it("uses a custom LiteLLM origin when the proxy is off", () => {
    const cfg = loadCavemanProxyConfig({
      LITELLM_BASE_URL: "http://127.0.0.1:4010/",
    });
    expect(resolveCodexUpstreamBaseUrl(cfg)).toBe("http://127.0.0.1:4010/v1");
  });
});
