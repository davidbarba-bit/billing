import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  // Drizzle Kit imports this file directly; if DATABASE_URL is missing, fail loudly.
  throw new Error("DATABASE_URL must be set to run drizzle-kit");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
