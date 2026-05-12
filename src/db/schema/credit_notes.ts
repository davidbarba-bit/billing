import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  index,
  integer,
  bigint,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { customers } from "./customers.js";
import { invoices, fees } from "./invoices.js";

export const creditNoteStatuses = ["draft", "finalized", "voided"] as const;
export type CreditNoteStatus = (typeof creditNoteStatuses)[number];

export const creditNoteRefundStatuses = [
  "pending",
  "succeeded",
  "failed",
] as const;
export type CreditNoteRefundStatus = (typeof creditNoteRefundStatuses)[number];

export const creditNotes = pgTable(
  "credit_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    sequentialId: integer("sequential_id").notNull(),
    number: text("number").notNull(),
    status: text("status").notNull().$type<CreditNoteStatus>().default("finalized"),
    refundStatus: text("refund_status").$type<CreditNoteRefundStatus>(),
    reason: text("reason").notNull(),
    description: text("description"),
    currency: text("currency").notNull(),
    creditAmountCents: bigint("credit_amount_cents", { mode: "number" }).notNull(),
    refundAmountCents: bigint("refund_amount_cents", { mode: "number" })
      .notNull()
      .default(0),
    totalAmountCents: bigint("total_amount_cents", { mode: "number" }).notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgNumberIdx: uniqueIndex("credit_notes_org_number_idx").on(
      t.organizationId,
      t.number,
    ),
    orgCustomerIdx: index("credit_notes_org_customer_idx").on(
      t.organizationId,
      t.customerId,
    ),
    // Postgres treats NULLs as distinct in unique indexes, so missing keys are fine.
    orgIdempotencyIdx: uniqueIndex("credit_notes_org_idempotency_idx").on(
      t.organizationId,
      t.idempotencyKey,
    ),
  }),
);

export const creditNoteItems = pgTable("credit_note_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditNoteId: uuid("credit_note_id")
    .notNull()
    .references(() => creditNotes.id, { onDelete: "cascade" }),
  feeId: uuid("fee_id")
    .notNull()
    .references(() => fees.id, { onDelete: "restrict" }),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CreditNote = typeof creditNotes.$inferSelect;
export type NewCreditNote = typeof creditNotes.$inferInsert;
export type CreditNoteItem = typeof creditNoteItems.$inferSelect;
export type NewCreditNoteItem = typeof creditNoteItems.$inferInsert;
