import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../../src/config.js";

describe("loadConfig", () => {
  afterEach(() => resetConfigCache());

  it("parses a minimal env", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x/x",
      LAGO_API_KEYS: "key1:slug1:Org 1",
    } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(3000);
    expect(cfg.apiKeys).toEqual([{ key: "key1", slug: "slug1", name: "Org 1" }]);
  });

  it("parses multiple comma-separated API keys", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x/x",
      LAGO_API_KEYS: "k1:s1:Org 1,k2:s2:Org 2",
    } as NodeJS.ProcessEnv);
    expect(cfg.apiKeys).toHaveLength(2);
    expect(cfg.apiKeys[1]?.key).toBe("k2");
  });

  it("falls back to slug for org name when name is missing", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x/x",
      LAGO_API_KEYS: "k:s",
    } as NodeJS.ProcessEnv);
    expect(cfg.apiKeys[0]?.name).toBe("s");
  });

  it("throws on duplicate API keys", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x/x",
        LAGO_API_KEYS: "dup:s1,dup:s2",
      } as NodeJS.ProcessEnv),
    ).toThrow(/Duplicate API key/);
  });

  it("throws when LAGO_API_KEYS is missing", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://x/x" } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("coerces PORT and PERIOD_CLOSE_INTERVAL_MS", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x/x",
      LAGO_API_KEYS: "k:s",
      PORT: "8080",
      PERIOD_CLOSE_INTERVAL_MS: "60000",
    } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(8080);
    expect(cfg.periodCloseIntervalMs).toBe(60_000);
  });
});
