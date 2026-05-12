import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name"),
    email: text("email"),
    currency: text("currency"),
    timezone: text("timezone"),
    billingConfiguration: jsonb("billing_configuration"),
    integrationCustomers: jsonb("integration_customers"),
    metadata: jsonb("metadata"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgExternalIdx: uniqueIndex("customers_org_external_idx").on(
      t.organizationId,
      t.externalId,
    ),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
