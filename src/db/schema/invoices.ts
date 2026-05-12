import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  index,
  integer,
  bigint,
  jsonb,
  numeric,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { customers } from "./customers.js";
import { subscriptions } from "./subscriptions.js";

export const invoiceStatuses = [
  "draft",
  "finalized",
  "voided",
  "failed",
] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

export const invoicePaymentStatuses = [
  "pending",
  "succeeded",
  "failed",
] as const;
export type InvoicePaymentStatus = (typeof invoicePaymentStatuses)[number];

export const invoiceTypes = ["one_off", "subscription"] as const;
export type InvoiceType = (typeof invoiceTypes)[number];

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    sequentialId: integer("sequential_id").notNull(),
    number: text("number").notNull(),
    invoiceType: text("invoice_type").notNull().$type<InvoiceType>(),
    status: text("status").notNull().$type<InvoiceStatus>(),
    paymentStatus: text("payment_status")
      .notNull()
      .$type<InvoicePaymentStatus>()
      .default("pending"),
    currency: text("currency").notNull(),
    issuingDate: timestamp("issuing_date", { withTimezone: true })
      .notNull()
      .defaultNow(),
    fromDatetime: timestamp("from_datetime", { withTimezone: true }),
    toDatetime: timestamp("to_datetime", { withTimezone: true }),
    subtotalExcludingTaxesCents: bigint("subtotal_excluding_taxes_cents", {
      mode: "number",
    }).notNull(),
    taxesAmountCents: bigint("taxes_amount_cents", { mode: "number" })
      .notNull()
      .default(0),
    totalAmountCents: bigint("total_amount_cents", { mode: "number" }).notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    taxesBreakdown: jsonb("taxes_breakdown").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgNumberIdx: uniqueIndex("invoices_org_number_idx").on(
      t.organizationId,
      t.number,
    ),
    orgCustomerIdx: index("invoices_org_customer_idx").on(
      t.organizationId,
      t.customerId,
    ),
  }),
);

export const feeTypes = [
  "charge",
  "subscription",
  "add_on",
  "credit",
] as const;
export type FeeType = (typeof feeTypes)[number];

export const fees = pgTable("fees", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  feeType: text("fee_type").notNull().$type<FeeType>(),
  itemCode: text("item_code").notNull(),
  itemName: text("item_name").notNull(),
  invoiceDisplayName: text("invoice_display_name"),
  units: numeric("units", { precision: 30, scale: 10 }).notNull(),
  unitAmountCents: bigint("unit_amount_cents", { mode: "number" }).notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  taxesAmountCents: bigint("taxes_amount_cents", { mode: "number" })
    .notNull()
    .default(0),
  totalAmountCents: bigint("total_amount_cents", { mode: "number" }).notNull(),
  properties: jsonb("properties").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type Fee = typeof fees.$inferSelect;
export type NewFee = typeof fees.$inferInsert;
