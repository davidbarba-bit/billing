import { Router } from "express";
import { and, eq, sql, isNull, desc } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { billableMetrics, type BillableMetric } from "../db/schema/index.js";
import { requireOrg } from "../lib/auth.js";
import { asyncHandler, pathParam } from "../lib/async.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { PaginationQuery, buildMeta } from "../lib/pagination.js";
import { CreateBillableMetricRequest } from "../schemas/billable_metrics.js";

export type BillableMetricResponse = {
  lago_id: string;
  name: string;
  code: string;
  description: string | null;
  aggregation_type: string;
  field_name: string | null;
  recurring: boolean;
  weighted_interval: string | null;
  created_at: string;
  // Counters: live where possible, 0 where the source table is phase-2/3.
  active_subscriptions_count: number;
  draft_invoices_count: number;
  plans_count: number;
};

export function serializeBillableMetric(b: BillableMetric): BillableMetricResponse {
  return {
    lago_id: b.id,
    name: b.name,
    code: b.code,
    description: b.description ?? null,
    aggregation_type: b.aggregationType,
    field_name: b.fieldName ?? null,
    recurring: b.recurring,
    weighted_interval: b.weightedInterval ?? null,
    created_at: b.createdAt.toISOString(),
    active_subscriptions_count: 0,
    draft_invoices_count: 0,
    plans_count: 0,
  };
}

export function buildBillableMetricsRouter(db: DB): Router {
  const router = Router();

  // POST /billable_metrics — STRICT: 422 on duplicate code.
  router.post(
    "/billable_metrics",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { billable_metric: input } = CreateBillableMetricRequest.parse(
        req.body,
      );

      const created = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: billableMetrics.id })
          .from(billableMetrics)
          .where(
            and(
              eq(billableMetrics.organizationId, org.id),
              eq(billableMetrics.code, input.code),
              isNull(billableMetrics.deletedAt),
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
          .insert(billableMetrics)
          .values({
            organizationId: org.id,
            name: input.name,
            code: input.code,
            description: input.description ?? null,
            aggregationType: input.aggregation_type,
            fieldName: input.field_name ?? null,
            recurring: input.recurring ?? false,
            weightedInterval: input.weighted_interval ?? null,
          })
          .returning();
        if (!inserted) throw new Error("insert billable_metric failed");
        return inserted;
      });

      res
        .status(200)
        .json({ billable_metric: serializeBillableMetric(created) });
    }),
  );

  // GET /billable_metrics — list
  router.get(
    "/billable_metrics",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { page, per_page } = PaginationQuery.parse(req.query);
      const offset = (page - 1) * per_page;

      const where = and(
        eq(billableMetrics.organizationId, org.id),
        isNull(billableMetrics.deletedAt),
      );

      const rows = await db
        .select()
        .from(billableMetrics)
        .where(where)
        .orderBy(desc(billableMetrics.createdAt))
        .limit(per_page)
        .offset(offset);

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(billableMetrics)
        .where(where);
      const total = countRows[0]?.count ?? 0;

      res.json({
        billable_metrics: rows.map(serializeBillableMetric),
        meta: buildMeta(page, per_page, total),
      });
    }),
  );

  // GET /billable_metrics/:code
  router.get(
    "/billable_metrics/:code",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const code = pathParam(req, "code");
      const [row] = await db
        .select()
        .from(billableMetrics)
        .where(
          and(
            eq(billableMetrics.organizationId, org.id),
            eq(billableMetrics.code, code),
            isNull(billableMetrics.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("billable_metric");
      res.json({ billable_metric: serializeBillableMetric(row) });
    }),
  );

  // DELETE /billable_metrics/:code — soft delete.
  router.delete(
    "/billable_metrics/:code",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const code = pathParam(req, "code");
      const [row] = await db
        .select()
        .from(billableMetrics)
        .where(
          and(
            eq(billableMetrics.organizationId, org.id),
            eq(billableMetrics.code, code),
            isNull(billableMetrics.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("billable_metric");
      const [deleted] = await db
        .update(billableMetrics)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(billableMetrics.id, row.id))
        .returning();
      if (!deleted) throw new Error("delete billable_metric failed");
      res.json({ billable_metric: serializeBillableMetric(deleted) });
    }),
  );

  return router;
}
