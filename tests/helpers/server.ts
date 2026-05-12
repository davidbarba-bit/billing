import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import pino from "pino";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../../src/db/schema/index.js";
import { organizations } from "../../src/db/schema/index.js";
import { buildApp } from "../../src/app.js";

export type TestHarness = {
  baseUrl: string;
  apiKey: string;
  organizationSlug: string;
  organizationId: string;
  db: NodePgDatabase<typeof schema>;
  pool: pg.Pool;
  server: Server;
  close: () => Promise<void>;
};

// `organizations` is intentionally NOT truncated: each test creates a fresh
// organization, and tests that spin up parallel harnesses (e.g. multi-tenant
// isolation checks) must not invalidate API keys minted by sibling harnesses.
const TABLES_TO_TRUNCATE = [
  "credit_note_items",
  "credit_notes",
  "fees",
  "invoices",
  "subscription_units",
  "subscriptions",
  "events",
  "plan_charges",
  "plans",
  "billable_metrics",
  "add_ons",
  "customer_taxes",
  "taxes",
  "customers",
  "webhook_deliveries",
];

function getDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL must be set to run integration tests (e.g. postgres://lago:lago@localhost:5432/lago)",
    );
  }
  return url;
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `TRUNCATE TABLE ${TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
    );
  } finally {
    client.release();
  }
}

export async function startTestServer(): Promise<TestHarness> {
  const databaseUrl = getDatabaseUrl();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  const db = drizzle(pool, { schema });

  await truncateAll(pool);

  const apiKey = `test-${randomBytes(8).toString("hex")}`;
  const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
  const organizationSlug = `org-${randomBytes(4).toString("hex")}`;

  const [org] = await db
    .insert(organizations)
    .values({
      slug: organizationSlug,
      name: `Org ${organizationSlug}`,
      apiKeyHash,
    })
    .returning();
  if (!org) throw new Error("failed to seed organization");

  const logger = pino({ level: "silent" });
  const app = buildApp(db, logger);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    apiKey,
    organizationSlug,
    organizationId: org.id,
    db,
    pool,
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await pool.end();
    },
  };
}
