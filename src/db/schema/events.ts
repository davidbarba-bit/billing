import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  index,
  jsonb,
  bigint,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull(),
    externalSubscriptionId: text("external_subscription_id").notNull(),
    code: text("code").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    properties: jsonb("properties").notNull().default({}),
    preciseTotalAmountCents: bigint("precise_total_amount_cents", {
      mode: "number",
    }),
    bodyHash: text("body_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgTxnIdx: uniqueIndex("events_org_txn_idx").on(
      t.organizationId,
      t.transactionId,
    ),
    subCodeIdx: index("events_sub_code_idx").on(
      t.externalSubscriptionId,
      t.code,
      t.timestamp,
    ),
  }),
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
