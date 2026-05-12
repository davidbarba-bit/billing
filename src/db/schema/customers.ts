import {
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  jsonb,
  integer,
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
    sequentialId: integer("sequential_id").notNull(),
    slug: text("slug").notNull(),

    // Free-form identity
    name: text("name"),
    firstname: text("firstname"),
    lastname: text("lastname"),
    customerType: text("customer_type"),
    legalName: text("legal_name"),
    legalNumber: text("legal_number"),
    taxIdentificationNumber: text("tax_identification_number"),
    email: text("email"),
    phone: text("phone"),
    url: text("url"),
    logoUrl: text("logo_url"),

    // Address
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    state: text("state"),
    zipcode: text("zipcode"),
    country: text("country"),

    // Money / locale
    currency: text("currency"),
    timezone: text("timezone"),
    netPaymentTerm: integer("net_payment_term"),
    externalSalesforceId: text("external_salesforce_id"),
    finalizeZeroAmountInvoice: text("finalize_zero_amount_invoice")
      .notNull()
      .default("inherit"),

    // Embeds (jsonb so we don't have to model every detail right now)
    billingConfiguration: jsonb("billing_configuration"),
    shippingAddress: jsonb("shipping_address"),
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
    orgSequentialIdx: uniqueIndex("customers_org_sequential_idx").on(
      t.organizationId,
      t.sequentialId,
    ),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
