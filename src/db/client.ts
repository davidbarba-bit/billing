import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type DB = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: DB | undefined;

export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  }
  return pool;
}

export function getDb(databaseUrl: string): DB {
  if (!db) {
    db = drizzle(getPool(databaseUrl), { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}

export { schema };
