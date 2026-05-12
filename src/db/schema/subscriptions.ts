import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { customers } from "./customers.js";
import { plans } from "./plans.js";

export const billingTimes = ["calendar", "anniversary"] as const;
export type BillingTime = (typeof billingTimes)[number];

export const subscriptionStatuses = [
  "active",
  "pending",
  "terminated",
  "canceled",
] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    externalId: text("external_id").notNull(),
    externalCustomerId: text("external_customer_id").notNull(),
    name: text("name"),
    status: text("status").notNull().$type<SubscriptionStatus>().default("active"),
    billingTime: text("billing_time").notNull().$type<BillingTime>(),
    subscriptionAt: timestamp("subscription_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
    }).notNull(),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgExternalIdx: uniqueIndex("subscriptions_org_external_idx").on(
      t.organizationId,
      t.externalId,
    ),
    orgPeriodEndIdx: index("subscriptions_period_end_idx").on(
      t.organizationId,
      t.currentPeriodEnd,
    ),
  }),
);

export const subscriptionUnits = pgTable(
  "subscription_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    billableMetricCode: text("billable_metric_code").notNull(),
    unitKey: text("unit_key").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bmIdx: index("subscription_units_bm_idx").on(t.subscriptionId, t.billableMetricCode),
    aliveIdx: index("subscription_units_alive_idx").on(
      t.subscriptionId,
      t.billableMetricCode,
      t.removedAt,
    ),
  }),
);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type SubscriptionUnit = typeof subscriptionUnits.$inferSelect;
export type NewSubscriptionUnit = typeof subscriptionUnits.$inferInsert;
