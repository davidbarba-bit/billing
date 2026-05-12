import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const aggregationTypes = [
  "count_agg",
  "sum_agg",
  "unique_count_agg",
  "max_agg",
  "latest_agg",
] as const;
export type AggregationType = (typeof aggregationTypes)[number];

export const billableMetrics = pgTable(
  "billable_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    aggregationType: text("aggregation_type").notNull().$type<AggregationType>(),
    fieldName: text("field_name"),
    recurring: boolean("recurring").notNull().default(false),
    weightedInterval: text("weighted_interval"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgCodeIdx: uniqueIndex("billable_metrics_org_code_idx").on(
      t.organizationId,
      t.code,
    ),
  }),
);

export type BillableMetric = typeof billableMetrics.$inferSelect;
export type NewBillableMetric = typeof billableMetrics.$inferInsert;
