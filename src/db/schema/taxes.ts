import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  numeric,
  boolean,
  primaryKey,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { customers } from "./customers.js";

export const taxes = pgTable(
  "taxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    rate: numeric("rate", { precision: 10, scale: 4 }).notNull(),
    description: text("description"),
    appliedToOrganization: boolean("applied_to_organization")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgCodeIdx: uniqueIndex("taxes_org_code_idx").on(t.organizationId, t.code),
  }),
);

export const customerTaxes = pgTable(
  "customer_taxes",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    taxId: uuid("tax_id")
      .notNull()
      .references(() => taxes.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.customerId, t.taxId] }),
  }),
);

export type Tax = typeof taxes.$inferSelect;
export type NewTax = typeof taxes.$inferInsert;
export type CustomerTax = typeof customerTaxes.$inferSelect;
