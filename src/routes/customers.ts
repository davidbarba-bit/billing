import { Router } from "express";
import { and, eq, sql, isNull, desc } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  customers,
  customerTaxes,
  taxes,
  type Customer,
} from "../db/schema/index.js";
import { requireOrg } from "../lib/auth.js";
import { asyncHandler, pathParam } from "../lib/async.js";
import { notFound } from "../lib/errors.js";
import { PaginationQuery, buildMeta } from "../lib/pagination.js";
import {
  CreateCustomerRequest,
  type CustomerResponse,
} from "../schemas/customers.js";

export function serializeCustomer(c: Customer): CustomerResponse {
  return {
    lago_id: c.id,
    external_id: c.externalId,
    name: c.name ?? null,
    email: c.email ?? null,
    currency: c.currency ?? null,
    timezone: c.timezone ?? null,
    billing_configuration: (c.billingConfiguration ?? null) as unknown,
    integration_customers: (c.integrationCustomers ?? null) as unknown,
    metadata: (c.metadata ?? null) as unknown,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

export function buildCustomersRouter(db: DB): Router {
  const router = Router();

  // POST /customers — upsert on (organization_id, external_id), like Lago.
  router.post(
    "/customers",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const parsed = CreateCustomerRequest.parse(req.body);
      const input = parsed.customer;

      const result = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.organizationId, org.id),
              eq(customers.externalId, input.external_id),
              isNull(customers.deletedAt),
            ),
          )
          .limit(1);

        const row = existing[0];
        const now = new Date();
        const values = {
          organizationId: org.id,
          externalId: input.external_id,
          name: input.name ?? null,
          email: input.email && input.email.length > 0 ? input.email : null,
          currency: input.currency ?? null,
          timezone: input.timezone ?? null,
          billingConfiguration: input.billing_configuration ?? null,
          integrationCustomers: input.integration_customers ?? null,
          metadata: input.metadata ?? null,
          updatedAt: now,
        };

        if (row) {
          const [updated] = await tx
            .update(customers)
            .set(values)
            .where(eq(customers.id, row.id))
            .returning();
          if (!updated) throw new Error("update customer failed");
          return { customer: updated, created: false };
        }

        const [inserted] = await tx
          .insert(customers)
          .values(values)
          .returning();
        if (!inserted) throw new Error("insert customer failed");

        // Auto-apply org-wide taxes.
        const orgTaxes = await tx
          .select({ id: taxes.id })
          .from(taxes)
          .where(
            and(
              eq(taxes.organizationId, org.id),
              eq(taxes.appliedToOrganization, true),
            ),
          );

        if (orgTaxes.length > 0) {
          await tx
            .insert(customerTaxes)
            .values(
              orgTaxes.map((t) => ({
                customerId: inserted.id,
                taxId: t.id,
              })),
            )
            .onConflictDoNothing();
        }

        return { customer: inserted, created: true };
      });

      res
        .status(result.created ? 201 : 200)
        .json({ customer: serializeCustomer(result.customer) });
    }),
  );

  // GET /customers — list customers
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

      res.json({
        customers: rows.map(serializeCustomer),
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
      res.json({ customer: serializeCustomer(row) });
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
      res.json({ customer: serializeCustomer(deleted) });
    }),
  );

  return router;
}
