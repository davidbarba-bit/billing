import { Router } from "express";
import { and, eq, inArray, sql, isNull, desc } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  plans,
  planCharges,
  billableMetrics,
  type Plan,
  type PlanCharge,
  type BillableMetric,
} from "../db/schema/index.js";
import { requireOrg } from "../lib/auth.js";
import { asyncHandler, pathParam } from "../lib/async.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { PaginationQuery, buildMeta } from "../lib/pagination.js";
import {
  CreatePlanRequest,
  type ChargeInput,
  type PlanInput,
} from "../schemas/plans.js";

type ChargeWithBm = PlanCharge & {
  billable_metric_code: string;
};

export type ChargeResponse = {
  lago_id: string;
  lago_billable_metric_id: string;
  invoice_display_name: string | null;
  billable_metric_code: string;
  created_at: string;
  charge_model: string;
  invoiceable: boolean;
  regroup_paid_fees: null;
  pay_in_advance: boolean;
  prorated: boolean;
  min_amount_cents: number;
  properties: Record<string, unknown>;
  filters: unknown[];
  taxes: unknown[];
};

export type PlanResponse = {
  lago_id: string;
  name: string;
  invoice_display_name: string | null;
  created_at: string;
  code: string;
  interval: string;
  description: string | null;
  amount_cents: number;
  amount_currency: string;
  trial_period: number | null;
  pay_in_advance: boolean;
  // Lago normalises this to null when the plan's interval is monthly.
  bill_charges_monthly: boolean | null;
  customers_count: number;
  active_subscriptions_count: number;
  draft_invoices_count: number;
  parent_id: string | null;
  charges: ChargeResponse[];
  usage_thresholds: unknown[];
  taxes: unknown[];
};

function normalizeAmount(value: string | number): string {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return num.toFixed(2);
}

function serializeCharge(c: ChargeWithBm): ChargeResponse {
  const props = c.properties as Record<string, unknown>;
  return {
    lago_id: c.id,
    lago_billable_metric_id: c.billableMetricId,
    invoice_display_name: c.invoiceDisplayName ?? null,
    billable_metric_code: c.billable_metric_code,
    created_at: c.createdAt.toISOString(),
    charge_model: c.chargeModel,
    invoiceable: c.invoiceable,
    regroup_paid_fees: null,
    pay_in_advance: c.payInAdvance,
    prorated: c.prorated,
    min_amount_cents: c.minAmountCents,
    properties: props,
    filters: [],
    taxes: [],
  };
}

export function serializePlan(p: Plan, charges: ChargeWithBm[]): PlanResponse {
  return {
    lago_id: p.id,
    name: p.name,
    invoice_display_name: p.invoiceDisplayName ?? null,
    created_at: p.createdAt.toISOString(),
    code: p.code,
    interval: p.interval,
    description: p.description ?? null,
    amount_cents: p.amountCents,
    amount_currency: p.amountCurrency,
    trial_period: p.trialPeriod ?? null,
    pay_in_advance: p.payInAdvance,
    bill_charges_monthly: p.interval === "monthly" ? null : p.billChargesMonthly,
    customers_count: 0,
    active_subscriptions_count: 0,
    draft_invoices_count: 0,
    parent_id: null,
    charges: charges.map(serializeCharge),
    usage_thresholds: [],
    taxes: [],
  };
}

async function loadPlanCharges(
  db: DB,
  planId: string,
): Promise<ChargeWithBm[]> {
  const rows = await db
    .select({
      charge: planCharges,
      bmCode: billableMetrics.code,
    })
    .from(planCharges)
    .innerJoin(
      billableMetrics,
      eq(planCharges.billableMetricId, billableMetrics.id),
    )
    .where(eq(planCharges.planId, planId))
    .orderBy(planCharges.createdAt);
  return rows.map((r) => ({ ...r.charge, billable_metric_code: r.bmCode }));
}

async function loadChargesForPlans(
  db: DB,
  planIds: string[],
): Promise<Map<string, ChargeWithBm[]>> {
  const out = new Map<string, ChargeWithBm[]>();
  if (planIds.length === 0) return out;
  const rows = await db
    .select({ charge: planCharges, bmCode: billableMetrics.code })
    .from(planCharges)
    .innerJoin(
      billableMetrics,
      eq(planCharges.billableMetricId, billableMetrics.id),
    )
    .where(inArray(planCharges.planId, planIds))
    .orderBy(planCharges.createdAt);
  for (const r of rows) {
    const charge: ChargeWithBm = { ...r.charge, billable_metric_code: r.bmCode };
    const arr = out.get(r.charge.planId) ?? [];
    arr.push(charge);
    out.set(r.charge.planId, arr);
  }
  return out;
}

/**
 * Validates every charge's billable_metric_id resolves within the org and the
 * `prorated:true → BM.recurring:true` invariant holds.
 */
async function resolveAndValidateCharges(
  tx: DB,
  orgId: string,
  inputs: readonly ChargeInput[],
): Promise<Map<string, BillableMetric>> {
  if (inputs.length === 0) return new Map();
  const ids = [...new Set(inputs.map((c) => c.billable_metric_id))];
  const rows = await tx
    .select()
    .from(billableMetrics)
    .where(
      and(
        eq(billableMetrics.organizationId, orgId),
        inArray(billableMetrics.id, ids),
        isNull(billableMetrics.deletedAt),
      ),
    );
  const map = new Map(rows.map((r) => [r.id, r]));

  for (let i = 0; i < inputs.length; i++) {
    const c = inputs[i]!;
    const bm = map.get(c.billable_metric_id);
    if (!bm) {
      throw unprocessable("validation_errors", "Unprocessable Entity", {
        [`charges.${i}.billable_metric_id`]: ["value_is_invalid"],
      });
    }
    if (c.prorated && !bm.recurring) {
      throw unprocessable(
        "validation_errors",
        "prorated charges require a recurring billable metric",
        { [`charges.${i}.prorated`]: ["value_is_invalid"] },
      );
    }
  }

  return map;
}

function planInsertValues(orgId: string, input: PlanInput) {
  return {
    organizationId: orgId,
    name: input.name,
    invoiceDisplayName: input.invoice_display_name ?? null,
    code: input.code,
    description: input.description ?? null,
    interval: input.interval,
    amountCents: input.amount_cents,
    amountCurrency: input.amount_currency,
    payInAdvance: input.pay_in_advance,
    billChargesMonthly: input.bill_charges_monthly ?? false,
    trialPeriod: input.trial_period ?? null,
  };
}

export function buildPlansRouter(db: DB): Router {
  const router = Router();

  // POST /plans — STRICT: 422 on duplicate code.
  router.post(
    "/plans",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { plan: input } = CreatePlanRequest.parse(req.body);

      const planId = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: plans.id })
          .from(plans)
          .where(
            and(
              eq(plans.organizationId, org.id),
              eq(plans.code, input.code),
              isNull(plans.deletedAt),
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

        await resolveAndValidateCharges(tx, org.id, input.charges ?? []);

        const [inserted] = await tx
          .insert(plans)
          .values(planInsertValues(org.id, input))
          .returning();
        if (!inserted) throw new Error("insert plan failed");

        if ((input.charges ?? []).length > 0) {
          await tx.insert(planCharges).values(
            (input.charges ?? []).map((c) => ({
              planId: inserted.id,
              billableMetricId: c.billable_metric_id,
              chargeModel: c.charge_model,
              invoiceable: c.invoiceable,
              prorated: c.prorated,
              payInAdvance: c.pay_in_advance,
              invoiceDisplayName: c.invoice_display_name ?? null,
              minAmountCents: c.min_amount_cents,
              properties: { ...c.properties, amount: normalizeAmount(c.properties.amount) },
            })),
          );
        }

        return inserted.id;
      });

      const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
      if (!plan) throw new Error("plan vanished after insert");
      const charges = await loadPlanCharges(db, plan.id);
      res.status(200).json({ plan: serializePlan(plan, charges) });
    }),
  );

  // GET /plans — list
  router.get(
    "/plans",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { page, per_page } = PaginationQuery.parse(req.query);
      const offset = (page - 1) * per_page;

      const where = and(
        eq(plans.organizationId, org.id),
        isNull(plans.deletedAt),
      );

      const rows = await db
        .select()
        .from(plans)
        .where(where)
        .orderBy(desc(plans.createdAt))
        .limit(per_page)
        .offset(offset);

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(plans)
        .where(where);
      const total = countRows[0]?.count ?? 0;

      const chargesMap = await loadChargesForPlans(
        db,
        rows.map((r) => r.id),
      );

      res.json({
        plans: rows.map((p) =>
          serializePlan(p, chargesMap.get(p.id) ?? []),
        ),
        meta: buildMeta(page, per_page, total),
      });
    }),
  );

  // GET /plans/:code
  router.get(
    "/plans/:code",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const code = pathParam(req, "code");
      const [row] = await db
        .select()
        .from(plans)
        .where(
          and(
            eq(plans.organizationId, org.id),
            eq(plans.code, code),
            isNull(plans.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("plan");
      const charges = await loadPlanCharges(db, row.id);
      res.json({ plan: serializePlan(row, charges) });
    }),
  );

  // PUT /plans/:code — partial update of plan-level fields. To mutate
  // charges, recreate the plan (Lago + Numaris both treat charges as a
  // create-time set; mini-Lago keeps the same simplicity).
  router.put(
    "/plans/:code",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const code = pathParam(req, "code");
      const body = req.body as { plan?: Record<string, unknown> };
      const raw = body?.plan ?? {};

      const [row] = await db
        .select()
        .from(plans)
        .where(
          and(
            eq(plans.organizationId, org.id),
            eq(plans.code, code),
            isNull(plans.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("plan");

      const patch: Partial<typeof plans.$inferInsert> = { updatedAt: new Date() };
      const has = (k: string): boolean => Object.hasOwn(raw, k);
      if (has("name")) patch.name = (raw["name"] as string | null) ?? row.name;
      if (has("invoice_display_name"))
        patch.invoiceDisplayName = (raw["invoice_display_name"] as string | null) ?? null;
      if (has("description"))
        patch.description = (raw["description"] as string | null) ?? null;
      if (has("amount_cents"))
        patch.amountCents = Number(raw["amount_cents"]);
      if (has("amount_currency"))
        patch.amountCurrency = String(raw["amount_currency"]);
      if (has("pay_in_advance"))
        patch.payInAdvance = Boolean(raw["pay_in_advance"]);
      if (has("bill_charges_monthly"))
        patch.billChargesMonthly = Boolean(raw["bill_charges_monthly"]);
      if (has("trial_period"))
        patch.trialPeriod = raw["trial_period"] as number | null;

      const [updated] = await db
        .update(plans)
        .set(patch)
        .where(eq(plans.id, row.id))
        .returning();
      if (!updated) throw new Error("update plan failed");
      const charges = await loadPlanCharges(db, updated.id);
      res.json({ plan: serializePlan(updated, charges) });
    }),
  );

  // DELETE /plans/:code
  router.delete(
    "/plans/:code",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const code = pathParam(req, "code");
      const [row] = await db
        .select()
        .from(plans)
        .where(
          and(
            eq(plans.organizationId, org.id),
            eq(plans.code, code),
            isNull(plans.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("plan");
      const [deleted] = await db
        .update(plans)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(plans.id, row.id))
        .returning();
      if (!deleted) throw new Error("delete plan failed");
      const charges = await loadPlanCharges(db, deleted.id);
      res.json({ plan: serializePlan(deleted, charges) });
    }),
  );

  return router;
}
