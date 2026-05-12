import { z } from "zod";

const ApiKeyEntry = z.object({
  key: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
});
export type ApiKeyEntry = z.infer<typeof ApiKeyEntry>;

function parseApiKeys(raw: string): ApiKeyEntry[] {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (entries.length === 0) {
    throw new Error("LAGO_API_KEYS must contain at least one entry");
  }

  const parsed = entries.map((entry) => {
    const parts = entry.split(":").map((p) => p.trim());
    const [key, slug, ...rest] = parts;
    if (!key || !slug) {
      throw new Error(
        `Invalid LAGO_API_KEYS entry "${entry}": expected key:slug[:name]`,
      );
    }
    const name = rest.length > 0 ? rest.join(":") : slug;
    return ApiKeyEntry.parse({ key, slug, name });
  });

  const seen = new Set<string>();
  for (const p of parsed) {
    if (seen.has(p.key)) {
      throw new Error(`Duplicate API key detected: ${p.key}`);
    }
    seen.add(p.key);
  }
  return parsed;
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().min(1),
  LAGO_API_KEYS: z.string().min(1),
  WEBHOOK_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  WEBHOOK_SIGNATURE_KEY: z.string().min(8).default("dev-signature-key"),
  PERIOD_CLOSE_INTERVAL_MS: z.coerce.number().int().nonnegative().default(3_600_000),
});

export type Config = {
  port: number;
  nodeEnv: "development" | "test" | "production";
  logLevel: string;
  databaseUrl: string;
  apiKeys: ApiKeyEntry[];
  webhookUrl: string | undefined;
  webhookSignatureKey: string;
  periodCloseIntervalMs: number;
};

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = EnvSchema.parse(env);
  cached = {
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    apiKeys: parseApiKeys(parsed.LAGO_API_KEYS),
    webhookUrl: parsed.WEBHOOK_URL,
    webhookSignatureKey: parsed.WEBHOOK_SIGNATURE_KEY,
    periodCloseIntervalMs: parsed.PERIOD_CLOSE_INTERVAL_MS,
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
