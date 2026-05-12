import { pgTable, text, timestamp, uuid, integer } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  webhookUrl: text("webhook_url"),
  timezone: text("timezone").notNull().default("UTC"),
  customerSequence: integer("customer_sequence").notNull().default(0),
  invoiceSequence: integer("invoice_sequence").notNull().default(0),
  creditNoteSequence: integer("credit_note_sequence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
