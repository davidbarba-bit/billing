import { Router } from "express";
import { and, eq, sql, desc } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  customers,
  organizations,
  plans,
  subscriptions,
  type Customer,
  type Organization,
  type Plan,
  type Subscription,
} from "../db/schema/index.js";
import { requireOrg } from "../lib/auth.js";
import { asyncHandler, pathParam } from "../lib/async.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { PaginationQuery, buildMeta } from "../lib/pagination.js";
import { CreateSubscriptionRequest } from "../schemas/subscriptions.js";
import { serializePlan, type PlanResponse } from "./plans.js";
import { planCharges, billableMetrics } from "../db/schema/index.js";
import { isNull } from "drizzle-orm";
import {
  anniversaryPeriodIn,
  endOfMonthIn,
} from "../lib/billing/tz-periods.js";

export type SubscriptionResponse = {
  lago_id: string;
  external_id: string;
  lago_customer_id: string;
  external_customer_id: string;
  name: string | null;
  plan_code: string;
  status: string;
  billing_time: string;
  subscription_at: string;
  started_at: string | null;
  trial_ended_at: null;
  ending_at: null;
  terminated_at: string | null;
  canceled_at: null;
  created_at: string;
  previous_plan_code: null;
  next_plan_code: null;
  downgrade_plan_date: null;
  current_billing_period_started_at: string | null;
  current_billing_period_ending_at: string | null;
  plan?: PlanResponse;
};

function applicableTz(customer: Customer, org: Organization): string {
  return customer.timezone ?? org.timezone ?? "UTC";
}

/**
 * Computes the first billing period for a fresh subscription.
 * For `calendar`: starts at `startedAt`, ends at end-of-month in `tz`.
 * For `anniversary`: anchored at `subscriptionAt`, span = 1 month in `tz`.
 */
export function computeInitialPeriod(
  sub: Pick<Subscription, "billingTime" | "subscriptionAt" | "startedAt">,
  tz: string,
): { start: Date; end: Date } {
  if (!sub.startedAt) {
    throw new Error("computeInitialPeriod called on a sub without startedAt");
  }
  if (sub.billingTime === "calendar") {
    return { start: sub.startedAt, end: endOfMonthIn(sub.startedAt, tz) };
  }
  // anniversary: anchor at subscription_at; period 0 contains startedAt.
  const { start, end } = anniversaryPeriodIn(
    sub.subscriptionAt,
    sub.startedAt,
    tz,
  );
  return { start, end };
}

function serializeSubscription(
  sub: Subscription,
  plan: Plan | undefined,
  embeddedPlan: PlanResponse | undefined,
): SubscriptionResponse {
  const planCode = plan?.code ?? "";
  const isActive = sub.status === "active";
  const out: SubscriptionResponse = {
    lago_id: sub.id,
    external_id: sub.externalId,
    lago_customer_id: sub.customerId,
    external_customer_id: sub.externalCustomerId,
    name: sub.name ?? null,
    plan_code: planCode,
    status: sub.status,
    billing_time: sub.billingTime,
    subscription_at: sub.subscriptionAt.toISOString(),
    started_at: sub.startedAt?.toISOString() ?? null,
    trial_ended_at: null,
    ending_at: null,
    terminated_at: sub.terminatedAt?.toISOString() ?? null,
    canceled_at: null,
    created_at: sub.createdAt.toISOString(),
    previous_plan_code: null,
    next_plan_code: null,
    downgrade_plan_date: null,
    current_billing_period_started_at: isActive
      ? sub.currentPeriodStart.toISOString()
      : null,
    current_billing_period_ending_at: isActive
      ? sub.currentPeriodEnd.toISOString()
      : null,
  };
  if (embeddedPlan) out.plan = embeddedPlan;
  return out;
}

async function loadPlanWithCharges(
  db: DB,
  planId: string,
): Promise<{ plan: Plan; embedded: PlanResponse } | null> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) return null;
  const rows = await db
    .select({ charge: planCharges, bmCode: billableMetrics.code })
    .from(planCharges)
    .innerJoin(
      billableMetrics,
      eq(planCharges.billableMetricId, billableMetrics.id),
    )
    .where(eq(planCharges.planId, plan.id))
    .orderBy(planCharges.createdAt);
  const charges = rows.map((r) => ({
    ...r.charge,
    billable_metric_code: r.bmCode,
  }));
  return { plan, embedded: serializePlan(plan, charges) };
}

export function buildSubscriptionsRouter(db: DB): Router {
  const router = Router();

  // POST /subscriptions
  router.post(
    "/subscriptions",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { subscription: input } = CreateSubscriptionRequest.parse(req.body);

      const result = await db.transaction(async (tx) => {
        // Resolve customer.
        const [customer] = await tx
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.organizationId, org.id),
              eq(customers.externalId, input.external_customer_id),
              isNull(customers.deletedAt),
            ),
          )
          .limit(1);
        if (!customer) {
          throw unprocessable("validation_errors", "Unprocessable Entity", {
            external_customer_id: ["value_is_invalid"],
          });
        }

        // Resolve plan.
        const [plan] = await tx
          .select()
          .from(plans)
          .where(
            and(
              eq(plans.organizationId, org.id),
              eq(plans.code, input.plan_code),
              isNull(plans.deletedAt),
            ),
          )
          .limit(1);
        if (!plan) {
          throw unprocessable("validation_errors", "Unprocessable Entity", {
            plan_code: ["value_is_invalid"],
          });
        }

        // Lago: external_id is unique per org. Duplicate → 422.
        const [dup] = await tx
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.organizationId, org.id),
              eq(subscriptions.externalId, input.external_id),
            ),
          )
          .limit(1);
        if (dup) {
          throw unprocessable("validation_errors", "Unprocessable Entity", {
            external_id: ["value_already_exist"],
          });
        }

        const tz = applicableTz(customer, org);
        const now = new Date();
        const subscriptionAt = input.subscription_at
          ? new Date(input.subscription_at)
          : now;

        const isFuture = subscriptionAt.getTime() > now.getTime();
        const status: "active" | "pending" = isFuture ? "pending" : "active";
        const startedAt = isFuture ? null : now;

        let periodStart = now;
        let periodEnd = now;
        if (status === "active" && startedAt) {
          const period = computeInitialPeriod(
            {
              billingTime: input.billing_time,
              subscriptionAt,
              startedAt,
            },
            tz,
          );
          periodStart = period.start;
          periodEnd = period.end;
        }

        const [inserted] = await tx
          .insert(subscriptions)
          .values({
            organizationId: org.id,
            customerId: customer.id,
            planId: plan.id,
            externalId: input.external_id,
            externalCustomerId: input.external_customer_id,
            name: input.name ?? null,
            status,
            billingTime: input.billing_time,
            subscriptionAt,
            startedAt,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          })
          .returning();
        if (!inserted) throw new Error("insert subscription failed");

        return { sub: inserted, plan };
      });

      const planEmbed = await loadPlanWithCharges(db, result.plan.id);
      const body = serializeSubscription(
        result.sub,
        result.plan,
        planEmbed?.embedded,
      );
      res.status(200).json({ subscription: body });
    }),
  );

  // GET /subscriptions?external_customer_id=...
  // The list endpoint omits the embedded plan (per the captured contract).
  router.get(
    "/subscriptions",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { page, per_page } = PaginationQuery.parse(req.query);
      const offset = (page - 1) * per_page;
      const externalCustomerId = req.query["external_customer_id"];

      const where = and(
        eq(subscriptions.organizationId, org.id),
        typeof externalCustomerId === "string"
          ? eq(subscriptions.externalCustomerId, externalCustomerId)
          : sql`true`,
      );

      const rows = await db
        .select({ sub: subscriptions, plan_code: plans.code })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(where)
        .orderBy(desc(subscriptions.createdAt))
        .limit(per_page)
        .offset(offset);

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(subscriptions)
        .where(where);
      const total = countRows[0]?.count ?? 0;

      res.json({
        subscriptions: rows.map((r) =>
          serializeSubscription(
            r.sub,
            { code: r.plan_code } as Plan,
            undefined,
          ),
        ),
        meta: buildMeta(page, per_page, total),
      });
    }),
  );

  // GET /subscriptions/:external_id — single sub, with plan embedded.
  router.get(
    "/subscriptions/:external_id",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const externalId = pathParam(req, "external_id");
      const [row] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.organizationId, org.id),
            eq(subscriptions.externalId, externalId),
          ),
        )
        .limit(1);
      if (!row) throw notFound("subscription");
      const planEmbed = await loadPlanWithCharges(db, row.planId);
      const body = serializeSubscription(row, planEmbed?.plan, planEmbed?.embedded);
      res.json({ subscription: body });
    }),
  );

  // DELETE /subscriptions/:external_id?status=...
  // Without `status=pending`, Lago only deletes ACTIVE subs (and 404s on
  // pending ones). With `status=pending`, only pending subs are deletable.
  router.delete(
    "/subscriptions/:external_id",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const externalId = pathParam(req, "external_id");
      const requestedStatus = req.query["status"];

      const [row] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.organizationId, org.id),
            eq(subscriptions.externalId, externalId),
          ),
        )
        .limit(1);

      if (!row) throw notFound("subscription");

      const wantsPending = requestedStatus === "pending";
      if (!wantsPending && row.status !== "active") {
        // Lago hides pending subs from the default delete path.
        throw notFound("subscription");
      }
      if (wantsPending && row.status !== "pending") {
        throw notFound("subscription");
      }

      const [updated] = await db
        .update(subscriptions)
        .set({
          status: wantsPending ? "canceled" : "terminated",
          terminatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, row.id))
        .returning();
      if (!updated) throw new Error("delete subscription failed");

      // Need plan code for the response.
      const [plan] = await db.select().from(plans).where(eq(plans.id, updated.planId));
      const body = serializeSubscription(updated, plan, undefined);
      res.json({ subscription: body });
    }),
  );

  return router;
}

void organizations;
