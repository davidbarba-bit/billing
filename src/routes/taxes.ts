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
import { notFound, unprocessable } from "../lib/errors.js";
import { PaginationQuery, buildMeta } from "../lib/pagination.js";
import { CreateTaxRequest } from "../schemas/taxes.js";

export type EmbeddedTax = {
  lago_id: string;
  name: string;
  code: string;
  rate: number;
  description: string | null;
  applied_to_organization: boolean;
  add_ons_count: number;
  customers_count: number;
  plans_count: number;
  charges_count: number;
  commitments_count: number;
  created_at: string;
};

/**
 * Builds the Lago-canonical tax payload, computing live counters via SQL.
 * `add_ons_count`, `plans_count`, `charges_count`, `commitments_count` are
 * always 0 until the corresponding resources land (phases 2 and 3); they're
 * still emitted so consumers don't break on missing keys.
 */
export async function serializeTaxEmbedded(
  db: DB,
  orgId: string,
  t: Tax,
): Promise<EmbeddedTax> {
  // customers_count: linked customers that haven't been soft-deleted.
  const customerCountRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(customerTaxes)
    .innerJoin(customers, eq(customers.id, customerTaxes.customerId))
    .where(
      and(
        eq(customerTaxes.taxId, t.id),
        eq(customers.organizationId, orgId),
        sql`${customers.deletedAt} is null`,
      ),
    );

  return {
    lago_id: t.id,
    name: t.name,
    code: t.code,
    rate: Number(t.rate),
    description: t.description ?? null,
    applied_to_organization: t.appliedToOrganization,
    add_ons_count: 0,
    customers_count: customerCountRows[0]?.count ?? 0,
    plans_count: 0,
    charges_count: 0,
    commitments_count: 0,
    created_at: t.createdAt.toISOString(),
  };
}

export function buildTaxesRouter(db: DB): Router {
  const router = Router();

  // POST /taxes — STRICT: 422 on duplicate code (Lago behavior).
  router.post(
    "/taxes",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { tax: input } = CreateTaxRequest.parse(req.body);

      const tax = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: taxes.id })
          .from(taxes)
          .where(
            and(eq(taxes.organizationId, org.id), eq(taxes.code, input.code)),
          )
          .limit(1);
        if (existing) {
          throw unprocessable(
            "validation_errors",
            "Unprocessable Entity",
            { code: ["value_already_exist"] },
          );
        }

        const values = {
          organizationId: org.id,
          name: input.name,
          code: input.code,
          rate: input.rate.toString(),
          description: input.description ?? null,
          appliedToOrganization: input.applied_to_organization ?? false,
        };
        const [inserted] = await tx.insert(taxes).values(values).returning();
        if (!inserted) throw new Error("insert tax failed");

        if (inserted.appliedToOrganization) {
          const rows = await tx
            .select({ id: customers.id })
            .from(customers)
            .where(eq(customers.organizationId, org.id));
          if (rows.length > 0) {
            await tx
              .insert(customerTaxes)
              .values(
                rows.map((c) => ({ customerId: c.id, taxId: inserted.id })),
              )
              .onConflictDoNothing();
          }
        }
        return inserted;
      });

      res
        .status(200)
        .json({ tax: await serializeTaxEmbedded(db, org.id, tax) });
    }),
  );

  // GET /taxes — list
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

      const serialized = await Promise.all(
        rows.map((r) => serializeTaxEmbedded(db, org.id, r)),
      );

      res.json({
        taxes: serialized,
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
      res.json({ tax: await serializeTaxEmbedded(db, org.id, row) });
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
      // Snapshot the embedded shape BEFORE the delete cascades the join rows.
      const embedded = await serializeTaxEmbedded(db, org.id, row);
      await db.delete(taxes).where(eq(taxes.id, row.id));
      res.json({ tax: embedded });
    }),
  );

  return router;
}
