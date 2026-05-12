import { Router } from "express";
import { and, eq, sql, desc } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  taxes,
  customers,
  customerTaxes,
  type Tax,
} from "../db/schema/index.js";
import { requireOrg } from "../lib/auth.js";
import { asyncHandler, pathParam } from "../lib/async.js";
import { notFound } from "../lib/errors.js";
import { PaginationQuery, buildMeta } from "../lib/pagination.js";
import {
  CreateTaxRequest,
  type TaxResponse,
} from "../schemas/taxes.js";

export function serializeTax(t: Tax): TaxResponse {
  return {
    lago_id: t.id,
    name: t.name,
    code: t.code,
    rate: Number(t.rate),
    description: t.description ?? null,
    applied_to_organization: t.appliedToOrganization,
    created_at: t.createdAt.toISOString(),
  };
}

export function buildTaxesRouter(db: DB): Router {
  const router = Router();

  // POST /taxes — upsert on (organization_id, code)
  router.post(
    "/taxes",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const parsed = CreateTaxRequest.parse(req.body);
      const input = parsed.tax;

      const result = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(taxes)
          .where(
            and(eq(taxes.organizationId, org.id), eq(taxes.code, input.code)),
          )
          .limit(1);

        const values = {
          organizationId: org.id,
          name: input.name,
          code: input.code,
          rate: input.rate.toString(),
          description: input.description ?? null,
          appliedToOrganization: input.applied_to_organization ?? false,
          updatedAt: new Date(),
        };

        let tax: Tax;
        let created: boolean;
        if (existing) {
          const [updated] = await tx
            .update(taxes)
            .set(values)
            .where(eq(taxes.id, existing.id))
            .returning();
          if (!updated) throw new Error("update tax failed");
          tax = updated;
          created = false;
        } else {
          const [inserted] = await tx.insert(taxes).values(values).returning();
          if (!inserted) throw new Error("insert tax failed");
          tax = inserted;
          created = true;
        }

        // If applied_to_organization, link to every existing customer.
        if (tax.appliedToOrganization) {
          const rows = await tx
            .select({ id: customers.id })
            .from(customers)
            .where(eq(customers.organizationId, org.id));
          if (rows.length > 0) {
            await tx
              .insert(customerTaxes)
              .values(rows.map((c) => ({ customerId: c.id, taxId: tax.id })))
              .onConflictDoNothing();
          }
        } else if (existing) {
          // If it was previously applied but is no longer org-wide, leave
          // existing per-customer links untouched (Lago semantics).
        }

        return { tax, created };
      });

      res
        .status(result.created ? 201 : 200)
        .json({ tax: serializeTax(result.tax) });
    }),
  );

  // GET /taxes
  router.get(
    "/taxes",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { page, per_page } = PaginationQuery.parse(req.query);
      const offset = (page - 1) * per_page;

      const where = eq(taxes.organizationId, org.id);
      const rows = await db
        .select()
        .from(taxes)
        .where(where)
        .orderBy(desc(taxes.createdAt))
        .limit(per_page)
        .offset(offset);

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(taxes)
        .where(where);
      const total = countRows[0]?.count ?? 0;

      res.json({
        taxes: rows.map(serializeTax),
        meta: buildMeta(page, per_page, total),
      });
    }),
  );

  // GET /taxes/:code
  router.get(
    "/taxes/:code",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const code = pathParam(req, "code");
      const [row] = await db
        .select()
        .from(taxes)
        .where(and(eq(taxes.organizationId, org.id), eq(taxes.code, code)))
        .limit(1);
      if (!row) throw notFound("tax");
      res.json({ tax: serializeTax(row) });
    }),
  );

  // DELETE /taxes/:code
  router.delete(
    "/taxes/:code",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const code = pathParam(req, "code");
      const [row] = await db
        .select()
        .from(taxes)
        .where(and(eq(taxes.organizationId, org.id), eq(taxes.code, code)))
        .limit(1);
      if (!row) throw notFound("tax");
      await db.delete(taxes).where(eq(taxes.id, row.id));
      res.json({ tax: serializeTax(row) });
    }),
  );

  return router;
}
