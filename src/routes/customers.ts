import { Router } from "express";
import { and, eq, inArray, sql, isNull, desc } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  customers,
  customerTaxes,
  organizations,
  taxes,
  type Customer,
  type Tax,
} from "../db/schema/index.js";
import { requireOrg } from "../lib/auth.js";
import { asyncHandler, pathParam } from "../lib/async.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { PaginationQuery, buildMeta } from "../lib/pagination.js";
import { buildCustomerSlug } from "../lib/slug.js";
import { serializeTaxEmbedded, type EmbeddedTax } from "./taxes.js";
import { CreateCustomerRequest } from "../schemas/customers.js";

const DEFAULT_BILLING_CONFIGURATION = {
  invoice_grace_period: null,
  payment_provider: null,
  payment_provider_code: null,
  document_locale: null,
};

const DEFAULT_SHIPPING_ADDRESS = {
  address_line1: null,
  address_line2: null,
  city: null,
  zipcode: null,
  state: null,
  country: null,
};

export type CustomerResponse = {
  lago_id: string;
  external_id: string;
  name: string | null;
  firstname: string | null;
  lastname: string | null;
  customer_type: string | null;
  sequential_id: number;
  slug: string;
  created_at: string;
  updated_at: string;
  country: string | null;
  address_line1: string | null;
  address_line2: string | null;
  state: string | null;
  zipcode: string | null;
  email: string | null;
  city: string | null;
  url: string | null;
  phone: string | null;
  logo_url: string | null;
  legal_name: string | null;
  legal_number: string | null;
  currency: string | null;
  tax_identification_number: string | null;
  timezone: string | null;
  applicable_timezone: string;
  net_payment_term: number | null;
  external_salesforce_id: string | null;
  finalize_zero_amount_invoice: string;
  billing_configuration: Record<string, unknown>;
  shipping_address: Record<string, unknown>;
  metadata: unknown[];
  taxes: EmbeddedTax[];
  integration_customers: unknown[];
};

export function serializeCustomer(
  c: Customer,
  appliedTaxes: EmbeddedTax[],
  orgTimezone: string | null = null,
): CustomerResponse {
  return {
    lago_id: c.id,
    external_id: c.externalId,
    name: c.name ?? null,
    firstname: c.firstname ?? null,
    lastname: c.lastname ?? null,
    customer_type: c.customerType ?? null,
    sequential_id: c.sequentialId,
    slug: c.slug,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
    country: c.country ?? null,
    address_line1: c.addressLine1 ?? null,
    address_line2: c.addressLine2 ?? null,
    state: c.state ?? null,
    zipcode: c.zipcode ?? null,
    email: c.email ?? null,
    city: c.city ?? null,
    url: c.url ?? null,
    phone: c.phone ?? null,
    logo_url: c.logoUrl ?? null,
    legal_name: c.legalName ?? null,
    legal_number: c.legalNumber ?? null,
    currency: c.currency ?? null,
    tax_identification_number: c.taxIdentificationNumber ?? null,
    timezone: c.timezone ?? null,
    applicable_timezone: c.timezone ?? orgTimezone ?? "UTC",
    net_payment_term: c.netPaymentTerm ?? null,
    external_salesforce_id: c.externalSalesforceId ?? null,
    finalize_zero_amount_invoice: c.finalizeZeroAmountInvoice,
    billing_configuration:
      (c.billingConfiguration as Record<string, unknown> | null) ??
      DEFAULT_BILLING_CONFIGURATION,
    shipping_address:
      (c.shippingAddress as Record<string, unknown> | null) ??
      DEFAULT_SHIPPING_ADDRESS,
    metadata: (c.metadata as unknown[] | null) ?? [],
    taxes: appliedTaxes,
    integration_customers: (c.integrationCustomers as unknown[] | null) ?? [],
  };
}

/**
 * Resolves the embedded taxes for a customer, complete with the live counters
 * Lago returns (customers_count, etc.). Cheap enough for single-customer reads;
 * for list endpoints we batch via {@link loadTaxesForCustomers}.
 */
async function loadTaxesForCustomer(
  db: DB,
  orgId: string,
  customerId: string,
): Promise<EmbeddedTax[]> {
  const rows = await db
    .select({ tax: taxes })
    .from(customerTaxes)
    .innerJoin(taxes, eq(customerTaxes.taxId, taxes.id))
    .where(eq(customerTaxes.customerId, customerId));
  if (rows.length === 0) return [];
  return Promise.all(
    rows.map((r) => serializeTaxEmbedded(db, orgId, r.tax)),
  );
}

async function loadTaxesForCustomers(
  db: DB,
  orgId: string,
  customerIds: string[],
): Promise<Map<string, EmbeddedTax[]>> {
  const out = new Map<string, EmbeddedTax[]>();
  if (customerIds.length === 0) return out;

  const rows = await db
    .select({ customerId: customerTaxes.customerId, tax: taxes })
    .from(customerTaxes)
    .innerJoin(taxes, eq(customerTaxes.taxId, taxes.id))
    .where(inArray(customerTaxes.customerId, customerIds));

  // Serialize tax counters once per tax (cache by id).
  const taxCache = new Map<string, EmbeddedTax>();
  for (const r of rows) {
    let serialized = taxCache.get(r.tax.id);
    if (!serialized) {
      serialized = await serializeTaxEmbedded(db, orgId, r.tax);
      taxCache.set(r.tax.id, serialized);
    }
    const arr = out.get(r.customerId) ?? [];
    arr.push(serialized);
    out.set(r.customerId, arr);
  }
  return out;
}

async function resolveTaxCodes(
  tx: DB,
  orgId: string,
  codes: readonly string[],
): Promise<Tax[]> {
  if (codes.length === 0) return [];
  const rows = await tx
    .select()
    .from(taxes)
    .where(
      and(eq(taxes.organizationId, orgId), inArray(taxes.code, codes as string[])),
    );
  const found = new Set(rows.map((r) => r.code));
  const missing = codes.filter((c) => !found.has(c));
  if (missing.length > 0) {
    throw unprocessable("validation_errors", "Unprocessable Entity", {
      tax_codes: missing.map(() => "value_is_invalid"),
    });
  }
  return rows;
}

export function buildCustomersRouter(db: DB): Router {
  const router = Router();

  // POST /customers — STRICT: 422 on duplicate external_id (Lago behavior).
  router.post(
    "/customers",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { customer: input } = CreateCustomerRequest.parse(req.body);

      const created = await db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              eq(customers.organizationId, org.id),
              eq(customers.externalId, input.external_id),
              isNull(customers.deletedAt),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          throw unprocessable(
            "validation_errors",
            "Unprocessable Entity",
            { external_id: ["value_already_exist"] },
          );
        }

        // Bump per-org sequential id atomically.
        const [seqRow] = await tx
          .update(organizations)
          .set({
            customerSequence: sql`${organizations.customerSequence} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, org.id))
          .returning({ seq: organizations.customerSequence });
        if (!seqRow) throw new Error("failed to bump customer sequence");
        const sequentialId = seqRow.seq;
        const slug = buildCustomerSlug(org.slug, org.id, sequentialId);

        // Resolve & validate any tax_codes BEFORE inserting.
        const explicitTaxes = await resolveTaxCodes(
          tx,
          org.id,
          input.tax_codes ?? [],
        );

        // Always pull org-wide taxes too.
        const orgWideTaxes = await tx
          .select({ id: taxes.id })
          .from(taxes)
          .where(
            and(
              eq(taxes.organizationId, org.id),
              eq(taxes.appliedToOrganization, true),
            ),
          );

        const values = {
          organizationId: org.id,
          externalId: input.external_id,
          sequentialId,
          slug,
          name: input.name ?? null,
          firstname: input.firstname ?? null,
          lastname: input.lastname ?? null,
          customerType: input.customer_type ?? null,
          legalName: input.legal_name ?? null,
          legalNumber: input.legal_number ?? null,
          taxIdentificationNumber: input.tax_identification_number ?? null,
          email:
            input.email && input.email.length > 0 ? input.email : null,
          phone: input.phone ?? null,
          url: input.url ?? null,
          logoUrl: input.logo_url ?? null,
          addressLine1: input.address_line1 ?? null,
          addressLine2: input.address_line2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          zipcode: input.zipcode ?? null,
          country: input.country ?? null,
          currency: input.currency ?? null,
          timezone: input.timezone ?? null,
          netPaymentTerm: input.net_payment_term ?? null,
          externalSalesforceId: input.external_salesforce_id ?? null,
          finalizeZeroAmountInvoice:
            input.finalize_zero_amount_invoice ?? "inherit",
          billingConfiguration: input.billing_configuration ?? null,
          shippingAddress: input.shipping_address ?? null,
          integrationCustomers: input.integration_customers ?? null,
          metadata: input.metadata ?? null,
        };

        const [inserted] = await tx.insert(customers).values(values).returning();
        if (!inserted) throw new Error("insert customer failed");

        const taxLinks = new Map<string, true>();
        for (const t of explicitTaxes) taxLinks.set(t.id, true);
        for (const t of orgWideTaxes) taxLinks.set(t.id, true);
        if (taxLinks.size > 0) {
          await tx
            .insert(customerTaxes)
            .values(
              [...taxLinks.keys()].map((taxId) => ({
                customerId: inserted.id,
                taxId,
              })),
            )
            .onConflictDoNothing();
        }

        return inserted;
      });

      const embedded = await loadTaxesForCustomer(db, org.id, created.id);
      res.status(200).json({ customer: serializeCustomer(created, embedded) });
    }),
  );

  // GET /customers — list
  router.get(
    "/customers",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { page, per_page } = PaginationQuery.parse(req.query);
      const offset = (page - 1) * per_page;

      const where = and(
        eq(customers.organizationId, org.id),
        isNull(customers.deletedAt),
      );

      const rows = await db
        .select()
        .from(customers)
        .where(where)
        .orderBy(desc(customers.createdAt))
        .limit(per_page)
        .offset(offset);

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(customers)
        .where(where);
      const total = countRows[0]?.count ?? 0;

      const taxMap = await loadTaxesForCustomers(
        db,
        org.id,
        rows.map((r) => r.id),
      );

      res.json({
        customers: rows.map((r) =>
          serializeCustomer(r, taxMap.get(r.id) ?? []),
        ),
        meta: buildMeta(page, per_page, total),
      });
    }),
  );

  // GET /customers/:external_id
  router.get(
    "/customers/:external_id",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const externalId = pathParam(req, "external_id");
      const [row] = await db
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.organizationId, org.id),
            eq(customers.externalId, externalId),
            isNull(customers.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("customer");
      const embedded = await loadTaxesForCustomer(db, org.id, row.id);
      res.json({ customer: serializeCustomer(row, embedded) });
    }),
  );

  // DELETE /customers/:external_id — soft delete
  router.delete(
    "/customers/:external_id",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const externalId = pathParam(req, "external_id");
      const [row] = await db
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.organizationId, org.id),
            eq(customers.externalId, externalId),
            isNull(customers.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("customer");
      const [deleted] = await db
        .update(customers)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(customers.id, row.id))
        .returning();
      if (!deleted) throw new Error("delete customer failed");
      const embedded = await loadTaxesForCustomer(db, org.id, deleted.id);
      res.json({ customer: serializeCustomer(deleted, embedded) });
    }),
  );

  return router;
}
