import { Router } from "express";
import { and, eq, isNull, inArray } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  customers,
  customerTaxes,
  taxes,
  plans,
  planCharges,
  billableMetrics,
  subscriptions,
} from "../db/schema/index.js";
import { requireOrg } from "../lib/auth.js";
import { asyncHandler, pathParam } from "../lib/async.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { computeChargeUsage, bankersRound } from "../lib/billing/usage.js";

export type CurrentUsageResponse = {
  customer_usage: {
    from_datetime: string;
    to_datetime: string;
    issuing_date: string;
    currency: string;
    amount_cents: number;
    total_amount_cents: number;
    taxes_amount_cents: number;
    lago_invoice_id: null;
    charges_usage: Array<{
      units: string;
      events_count: number;
      amount_cents: number;
      amount_currency: string;
      charge: {
        lago_id: string;
        charge_model: string;
        invoice_display_name: string | null;
      };
      billable_metric: {
        lago_id: string;
        name: string;
        code: string;
        aggregation_type: string;
      };
      filters: unknown[];
      grouped_usage: unknown[];
    }>;
  };
};

function issuingDateStr(periodEnd: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(periodEnd); // en-CA gives YYYY-MM-DD
}

export function buildCurrentUsageRouter(db: DB): Router {
  const router = Router();

  router.get(
    "/customers/:external_id/current_usage",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const externalId = pathParam(req, "external_id");
      const externalSubscriptionId =
        typeof req.query["external_subscription_id"] === "string"
          ? req.query["external_subscription_id"]
          : undefined;
      const applyTaxes = req.query["apply_taxes"] !== "false";

      const [customer] = await db
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
      if (!customer) throw notFound("customer");

      // Resolve subscription. If the customer has >1 sub, the SDK requires
      // external_subscription_id; mini-Lago enforces the same constraint.
      const customerSubs = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.organizationId, org.id),
            eq(subscriptions.customerId, customer.id),
            eq(subscriptions.status, "active"),
          ),
        );

      let sub = customerSubs[0];
      if (externalSubscriptionId) {
        sub = customerSubs.find(
          (s) => s.externalId === externalSubscriptionId,
        );
      } else if (customerSubs.length > 1) {
        throw unprocessable("validation_errors", "Unprocessable Entity", {
          external_subscription_id: ["value_is_blank"],
        });
      }
      if (!sub) {
        // Mirror Lago: no active sub → not_found
        throw notFound("subscription");
      }

      // Load plan + charges + BMs.
      const [plan] = await db
        .select()
        .from(plans)
        .where(eq(plans.id, sub.planId));
      if (!plan) throw new Error("plan referenced by subscription missing");

      const chargeRows = await db
        .select({
          charge: planCharges,
          bm: billableMetrics,
        })
        .from(planCharges)
        .innerJoin(
          billableMetrics,
          eq(planCharges.billableMetricId, billableMetrics.id),
        )
        .where(eq(planCharges.planId, plan.id))
        .orderBy(planCharges.createdAt);

      const tz = customer.timezone ?? org.timezone ?? "UTC";

      const chargesUsage = await Promise.all(
        chargeRows.map(async ({ charge, bm }) => {
          const usage = await computeChargeUsage(db, {
            orgId: org.id,
            subscription: sub,
            bm,
            charge: {
              prorated: charge.prorated,
              properties: charge.properties as Record<string, unknown>,
            },
            tz,
          });
          return {
            units: usage.units,
            events_count: usage.events_count,
            amount_cents: usage.amount_cents,
            amount_currency: plan.amountCurrency,
            charge: {
              lago_id: charge.id,
              charge_model: charge.chargeModel,
              invoice_display_name: charge.invoiceDisplayName ?? null,
            },
            billable_metric: {
              lago_id: bm.id,
              name: bm.name,
              code: bm.code,
              aggregation_type: bm.aggregationType,
            },
            filters: [],
            grouped_usage: [],
          };
        }),
      );

      const amountCents = chargesUsage.reduce(
        (acc, c) => acc + c.amount_cents,
        0,
      );

      let taxesAmountCents = 0;
      if (applyTaxes) {
        const linkedTaxes = await db
          .select({ rate: taxes.rate })
          .from(customerTaxes)
          .innerJoin(taxes, eq(customerTaxes.taxId, taxes.id))
          .where(
            and(
              eq(customerTaxes.customerId, customer.id),
              inArray(taxes.organizationId, [org.id]),
            ),
          );
        const totalRate = linkedTaxes.reduce(
          (acc, t) => acc + Number(t.rate),
          0,
        );
        taxesAmountCents = bankersRound((amountCents * totalRate) / 100);
      }

      const totalAmountCents = amountCents + taxesAmountCents;

      const body: CurrentUsageResponse = {
        customer_usage: {
          from_datetime: sub.currentPeriodStart.toISOString(),
          to_datetime: sub.currentPeriodEnd.toISOString(),
          issuing_date: issuingDateStr(sub.currentPeriodEnd, tz),
          currency: plan.amountCurrency,
          amount_cents: amountCents,
          total_amount_cents: totalAmountCents,
          taxes_amount_cents: taxesAmountCents,
          lago_invoice_id: null,
          charges_usage: chargesUsage,
        },
      };

      res.json(body);
    }),
  );

  return router;
}
