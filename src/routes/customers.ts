import { Router } from "express";
import { and, eq, inArray, notInArray, sql, isNull, desc } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  customers,
  customerTaxes,
  organizations,
  taxes,
  type Customer,
  type NewCustomer,
  type Tax,
} from "../db/schema/index.js";
import { requireOrg } from "../lib/auth.js";
import { asyncHandler, pathParam } from "../lib/async.js";
import { notFound, unprocessable, LagoError } from "../lib/errors.js";
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

/**
 * Builds the patch column-by-column. Only keys actually present in the raw
 * request body are written; missing keys are preserved (matches Lago's upsert
 * semantics: re-`POST` with a partial customer mutates only what's sent).
 */
function buildCustomerPatch(
  raw: Record<string, unknown>,
  parsed: Record<string, unknown>,
): Partial<NewCustomer> {
  const patch: Partial<NewCustomer> = {};
  const has = (k: string): boolean => Object.hasOwn(raw, k);

  if (has("name")) patch.name = (parsed["name"] as string | null) ?? null;
  if (has("firstname"))
    patch.firstname = (parsed["firstname"] as string | null) ?? null;
  if (has("lastname"))
    patch.lastname = (parsed["lastname"] as string | null) ?? null;
  if (has("customer_type"))
    patch.customerType = (parsed["customer_type"] as string | null) ?? null;
  if (has("legal_name"))
    patch.legalName = (parsed["legal_name"] as string | null) ?? null;
  if (has("legal_number"))
    patch.legalNumber = (parsed["legal_number"] as string | null) ?? null;
  if (has("tax_identification_number"))
    patch.taxIdentificationNumber =
      (parsed["tax_identification_number"] as string | null) ?? null;
  if (has("email")) {
    const e = parsed["email"] as string | null | undefined;
    patch.email = e && e.length > 0 ? e : null;
  }
  if (has("phone")) patch.phone = (parsed["phone"] as string | null) ?? null;
  if (has("url")) patch.url = (parsed["url"] as string | null) ?? null;
  if (has("logo_url"))
    patch.logoUrl = (parsed["logo_url"] as string | null) ?? null;
  if (has("address_line1"))
    patch.addressLine1 = (parsed["address_line1"] as string | null) ?? null;
  if (has("address_line2"))
    patch.addressLine2 = (parsed["address_line2"] as string | null) ?? null;
  if (has("city")) patch.city = (parsed["city"] as string | null) ?? null;
  if (has("state")) patch.state = (parsed["state"] as string | null) ?? null;
  if (has("zipcode"))
    patch.zipcode = (parsed["zipcode"] as string | null) ?? null;
  if (has("country"))
    patch.country = (parsed["country"] as string | null) ?? null;
  if (has("currency"))
    patch.currency = (parsed["currency"] as string | null) ?? null;
  if (has("timezone"))
    patch.timezone = (parsed["timezone"] as string | null) ?? null;
  if (has("net_payment_term"))
    patch.netPaymentTerm = (parsed["net_payment_term"] as number | null) ?? null;
  if (has("external_salesforce_id"))
    patch.externalSalesforceId =
      (parsed["external_salesforce_id"] as string | null) ?? null;
  if (has("finalize_zero_amount_invoice"))
    patch.finalizeZeroAmountInvoice =
      (parsed["finalize_zero_amount_invoice"] as string | null) ?? "inherit";
  if (has("billing_configuration"))
    patch.billingConfiguration =
      (parsed["billing_configuration"] as Record<string, unknown> | null) ?? null;
  if (has("shipping_address"))
    patch.shippingAddress =
      (parsed["shipping_address"] as Record<string, unknown> | null) ?? null;
  if (has("integration_customers"))
    patch.integrationCustomers =
      (parsed["integration_customers"] as unknown[] | null) ?? null;
  if (has("metadata"))
    patch.metadata = (parsed["metadata"] as unknown[] | null) ?? null;

  return patch;
}

/**
 * Replaces the explicit tax_codes for a customer. Org-wide taxes
 * (applied_to_organization=true) are always retained — they don't belong to
 * the user-managed set.
 */
async function syncCustomerTaxCodes(
  tx: DB,
  orgId: string,
  customerId: string,
  codes: readonly string[],
): Promise<void> {
  const resolved = await resolveTaxCodes(tx, orgId, codes);
  const explicitIds = new Set(resolved.map((t) => t.id));

  const orgWide = await tx
    .select({ id: taxes.id })
    .from(taxes)
    .where(
      and(
        eq(taxes.organizationId, orgId),
        eq(taxes.appliedToOrganization, true),
      ),
    );
  const orgWideIds = new Set(orgWide.map((t) => t.id));

  const keep = new Set([...explicitIds, ...orgWideIds]);

  // Drop links that are neither explicit nor org-wide.
  if (keep.size === 0) {
    await tx.delete(customerTaxes).where(eq(customerTaxes.customerId, customerId));
  } else {
    await tx
      .delete(customerTaxes)
      .where(
        and(
          eq(customerTaxes.customerId, customerId),
          notInArray(customerTaxes.taxId, [...keep]),
        ),
      );
  }

  if (keep.size > 0) {
    await tx
      .insert(customerTaxes)
      .values([...keep].map((taxId) => ({ customerId, taxId })))
      .onConflictDoNothing();
  }
}

export function buildCustomersRouter(db: DB): Router {
  const router = Router();

  // POST /customers — UPSERT by (org, external_id). Matches Lago: re-POST with
  // the same external_id mutates only the fields sent; unsent fields persist.
  // No PUT /customers/:external_id endpoint exists in Lago — that route is
  // explicitly answered with 404 resource_not_found below.
  router.post(
    "/customers",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const rawBody = req.body as { customer?: Record<string, unknown> };
      const rawCustomer = rawBody?.customer ?? {};
      const parsed = CreateCustomerRequest.parse(rawBody).customer as Record<
        string,
        unknown
      >;

      const customer = await db.transaction(async (tx) => {
        const externalId = parsed["external_id"] as string;
        const [existing] = await tx
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

        let row: Customer;

        if (existing) {
          const patch = buildCustomerPatch(rawCustomer, parsed);
          patch.updatedAt = new Date();
          const [updated] = await tx
            .update(customers)
            .set(patch)
            .where(eq(customers.id, existing.id))
            .returning();
          if (!updated) throw new Error("update customer failed");
          row = updated;
        } else {
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

          const insertPatch = buildCustomerPatch(rawCustomer, parsed);
          const values: NewCustomer = {
            organizationId: org.id,
            externalId,
            sequentialId,
            slug,
            finalizeZeroAmountInvoice: "inherit",
            ...insertPatch,
          };
          const [inserted] = await tx.insert(customers).values(values).returning();
          if (!inserted) throw new Error("insert customer failed");
          row = inserted;
        }

        // Sync taxes. tax_codes is REPLACE-semantics when sent; preserved when
        // not sent. Org-wide taxes are always retained on the customer.
        if (Object.hasOwn(rawCustomer, "tax_codes")) {
          const codes = (parsed["tax_codes"] as string[] | null) ?? [];
          await syncCustomerTaxCodes(tx, org.id, row.id, codes);
        } else if (!existing) {
          // First create with no tax_codes provided: still link org-wide.
          await syncCustomerTaxCodes(tx, org.id, row.id, []);
        }

        return row;
      });

      const embedded = await loadTaxesForCustomer(db, org.id, customer.id);
      res.status(200).json({ customer: serializeCustomer(customer, embedded) });
    }),
  );

  // PUT /customers/:external_id — Lago does NOT expose this; return its exact
  // 404 shape so Numaris (or any other client) can detect "you meant POST".
  router.put("/customers/:external_id", (_req, _res, next) => {
    next(
      new LagoError({
        status: 404,
        error: "Not Found",
        code: "resource_not_found",
      }),
    );
  });

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
