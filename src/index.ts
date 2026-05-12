import { loadConfig } from "./config.js";
import { getDb, closeDb } from "./db/client.js";
import { buildLogger } from "./lib/logger.js";
import { syncOrganizations } from "./lib/auth.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger(config);
  const db = getDb(config.databaseUrl);

  await syncOrganizations(db, config);

  const app = buildApp(db, logger);
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "mini-lago listening");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("fatal", err);
  process.exit(1);
});
