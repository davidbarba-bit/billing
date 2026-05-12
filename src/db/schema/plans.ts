import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  bigint,
  boolean,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { billableMetrics } from "./billable_metrics.js";

export const planIntervals = ["weekly", "monthly", "yearly"] as const;
export type PlanInterval = (typeof planIntervals)[number];

export const chargeModels = [
  "standard",
  "package",
  "graduated",
  "percentage",
  "volume",
] as const;
export type ChargeModel = (typeof chargeModels)[number];

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    invoiceDisplayName: text("invoice_display_name"),
    code: text("code").notNull(),
    description: text("description"),
    interval: text("interval").notNull().$type<PlanInterval>(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    amountCurrency: text("amount_currency").notNull(),
    payInAdvance: boolean("pay_in_advance").notNull().default(false),
    billChargesMonthly: boolean("bill_charges_monthly").notNull().default(false),
    trialPeriod: integer("trial_period"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgCodeIdx: uniqueIndex("plans_org_code_idx").on(t.organizationId, t.code),
  }),
);

export const planCharges = pgTable("plan_charges", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id")
    .notNull()
    .references(() => plans.id, { onDelete: "cascade" }),
  billableMetricId: uuid("billable_metric_id")
    .notNull()
    .references(() => billableMetrics.id, { onDelete: "restrict" }),
  chargeModel: text("charge_model").notNull().$type<ChargeModel>(),
  invoiceable: boolean("invoiceable").notNull().default(true),
  prorated: boolean("prorated").notNull().default(false),
  payInAdvance: boolean("pay_in_advance").notNull().default(false),
  invoiceDisplayName: text("invoice_display_name"),
  minAmountCents: bigint("min_amount_cents", { mode: "number" })
    .notNull()
    .default(0),
  properties: jsonb("properties").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type PlanCharge = typeof planCharges.$inferSelect;
export type NewPlanCharge = typeof planCharges.$inferInsert;
