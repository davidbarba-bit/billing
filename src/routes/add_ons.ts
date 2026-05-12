import { Router } from "express";
import { and, eq, sql, isNull, desc } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { addOns, type AddOn } from "../db/schema/index.js";
import { requireOrg } from "../lib/auth.js";
import { asyncHandler, pathParam } from "../lib/async.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { PaginationQuery, buildMeta } from "../lib/pagination.js";
import { CreateAddOnRequest } from "../schemas/add_ons.js";

export type AddOnResponse = {
  lago_id: string;
  name: string;
  invoice_display_name: string | null;
  code: string;
  amount_cents: number;
  amount_currency: string;
  created_at: string;
  description: string | null;
  taxes: unknown[];
};

export function serializeAddOn(a: AddOn): AddOnResponse {
  return {
    lago_id: a.id,
    name: a.name,
    invoice_display_name: a.invoiceDisplayName ?? null,
    code: a.code,
    amount_cents: a.amountCents,
    amount_currency: a.amountCurrency,
    created_at: a.createdAt.toISOString(),
    description: a.description ?? null,
    taxes: [],
  };
}

export function buildAddOnsRouter(db: DB): Router {
  const router = Router();

  // POST /add_ons — STRICT: 422 on duplicate code (Lago behavior).
  router.post(
    "/add_ons",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { add_on: input } = CreateAddOnRequest.parse(req.body);

      const created = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: addOns.id })
          .from(addOns)
          .where(
            and(
              eq(addOns.organizationId, org.id),
              eq(addOns.code, input.code),
              isNull(addOns.deletedAt),
            ),
          )
          .limit(1);
        if (existing) {
          throw unprocessable(
            "validation_errors",
            "Unprocessable Entity",
            { code: ["value_already_exist"] },
          );
        }

        const [inserted] = await tx
          .insert(addOns)
          .values({
            organizationId: org.id,
            name: input.name,
            invoiceDisplayName: input.invoice_display_name ?? null,
            code: input.code,
            description: input.description ?? null,
            amountCents: input.amount_cents,
            amountCurrency: input.amount_currency,
          })
          .returning();
        if (!inserted) throw new Error("insert add_on failed");
        return inserted;
      });

      res.status(200).json({ add_on: serializeAddOn(created) });
    }),
  );

  // GET /add_ons — list
  router.get(
    "/add_ons",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { page, per_page } = PaginationQuery.parse(req.query);
      const offset = (page - 1) * per_page;

      const where = and(
        eq(addOns.organizationId, org.id),
        isNull(addOns.deletedAt),
      );

      const rows = await db
        .select()
        .from(addOns)
        .where(where)
        .orderBy(desc(addOns.createdAt))
        .limit(per_page)
        .offset(offset);

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(addOns)
        .where(where);
      const total = countRows[0]?.count ?? 0;

      res.json({
        add_ons: rows.map(serializeAddOn),
        meta: buildMeta(page, per_page, total),
      });
    }),
  );

  // GET /add_ons/:code
  router.get(
    "/add_ons/:code",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const code = pathParam(req, "code");
      const [row] = await db
        .select()
        .from(addOns)
        .where(
          and(
            eq(addOns.organizationId, org.id),
            eq(addOns.code, code),
            isNull(addOns.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("add_on");
      res.json({ add_on: serializeAddOn(row) });
    }),
  );

  // DELETE /add_ons/:code — soft delete.
  // D6: phase 3 will reject (409) when fees reference it; for now the fees
  // table is unused so the simple soft-delete is the canonical behavior.
  router.delete(
    "/add_ons/:code",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const code = pathParam(req, "code");
      const [row] = await db
        .select()
        .from(addOns)
        .where(
          and(
            eq(addOns.organizationId, org.id),
            eq(addOns.code, code),
            isNull(addOns.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("add_on");
      const [deleted] = await db
        .update(addOns)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(addOns.id, row.id))
        .returning();
      if (!deleted) throw new Error("delete add_on failed");
      res.json({ add_on: serializeAddOn(deleted) });
    }),
  );

  return router;
}
