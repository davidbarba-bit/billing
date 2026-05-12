import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const webhookStatuses = [
  "pending",
  "delivered",
  "failed",
  "dead",
] as const;
export type WebhookStatus = (typeof webhookStatuses)[number];

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    webhookType: text("webhook_type").notNull(),
    targetUrl: text("target_url").notNull(),
    payload: jsonb("payload").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    status: text("status").notNull().$type<WebhookStatus>().default("pending"),
    lastError: text("last_error"),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pendingIdx: index("webhook_pending_idx").on(t.status, t.nextAttemptAt),
  }),
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
