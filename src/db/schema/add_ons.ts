import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  bigint,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const addOns = pgTable(
  "add_ons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    amountCurrency: text("amount_currency").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgCodeIdx: uniqueIndex("add_ons_org_code_idx").on(
      t.organizationId,
      t.code,
    ),
  }),
);

export type AddOn = typeof addOns.$inferSelect;
export type NewAddOn = typeof addOns.$inferInsert;
