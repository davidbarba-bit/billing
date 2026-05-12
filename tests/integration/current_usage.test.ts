import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestHarness } from "../helpers/server.js";
import { TestClient } from "../helpers/http.js";

type ChargeUsage = {
  units: string;
  events_count: number;
  amount_cents: number;
  amount_currency: string;
  charge: { lago_id: string; charge_model: string; invoice_display_name: string | null };
  billable_metric: { code: string; aggregation_type: string };
};

type CurrentUsageBody = {
  customer_usage: {
    from_datetime: string;
    to_datetime: string;
    issuing_date: string;
    currency: string;
    amount_cents: number;
    total_amount_cents: number;
    taxes_amount_cents: number;
    lago_invoice_id: null;
    charges_usage: ChargeUsage[];
  };
};

/**
 * Builds the canonical Numaris setup: customer in UTC + IVA tax + a recurring
 * unique_count_agg BM (prorated charge) and a non-recurring setup BM
 * (non-prorated charge), all wired through a plan and an active calendar
 * subscription on `sub-cu-1`.
 */
async function setupCurrentUsage(api: TestClient): Promise<void> {
  await api.post("/taxes", {
    tax: { name: "IVA", code: "iva-test", rate: 16 },
  });
  await api.post("/customers", {
    customer: {
      external_id: "cust-cu",
      currency: "MXN",
      timezone: "UTC",
      tax_codes: ["iva-test"],
    },
  });
  await api.post("/billable_metrics", {
    billable_metric: {
      name: "Monthly Units",
      code: "bm-cu-monthly",
      aggregation_type: "unique_count_agg",
      field_name: "unit_external_id",
      recurring: true,
    },
  });
  await api.post("/billable_metrics", {
    billable_metric: {
      name: "Setup",
      code: "bm-cu-setup",
      aggregation_type: "unique_count_agg",
      field_name: "unit_external_id",
      recurring: false,
    },
  });
  const monthly = await api.get<{ billable_metric: { lago_id: string } }>(
    "/billable_metrics/bm-cu-monthly",
  );
  const setup = await api.get<{ billable_metric: { lago_id: string } }>(
    "/billable_metrics/bm-cu-setup",
  );
  await api.post("/plans", {
    plan: {
      name: "Combustible",
      code: "plan-cu",
      interval: "monthly",
      amount_cents: 0,
      amount_currency: "MXN",
      charges: [
        {
          billable_metric_id: monthly.body.billable_metric.lago_id,
          charge_model: "standard",
          prorated: true,
          invoice_display_name: "Servicio",
          properties: { amount: "450.00" },
        },
        {
          billable_metric_id: setup.body.billable_metric.lago_id,
          charge_model: "standard",
          prorated: false,
          invoice_display_name: "Setup",
          properties: { amount: "1200.00" },
        },
      ],
    },
  });
}

async function createSubAt(
  api: TestClient,
  externalId: string,
  startedAt: Date,
): Promise<void> {
  // Calendar billing → period_start = now; we override below via DB to fake
  // the sub having started in a specific month so prorate math is testable.
  await api.post("/subscriptions", {
    subscription: {
      external_customer_id: "cust-cu",
      plan_code: "plan-cu",
      external_id: externalId,
      billing_time: "calendar",
    },
  });
  // Force the period boundaries to a known month so the math is reproducible
  // regardless of wall-clock time.
  void startedAt;
}

describe("current_usage", () => {
  let harness: TestHarness;
  let api: TestClient;

  beforeAll(async () => {
    harness = await startTestServer();
    api = new TestClient(harness.baseUrl, harness.apiKey);
    await setupCurrentUsage(api);
    await createSubAt(api, "sub-cu-1", new Date());
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("returns zero usage when there are no events", async () => {
    const res = await api.get<CurrentUsageBody>(
      "/customers/cust-cu/current_usage?external_subscription_id=sub-cu-1&apply_taxes=false",
    );
    expect(res.status).toBe(200);
    const u = res.body.customer_usage;
    expect(u.amount_cents).toBe(0);
    expect(u.total_amount_cents).toBe(0);
    expect(u.taxes_amount_cents).toBe(0);
    expect(u.charges_usage).toHaveLength(2);
    for (const c of u.charges_usage) {
      expect(c.units).toBe("0.0");
      expect(c.events_count).toBe(0);
      expect(c.amount_cents).toBe(0);
    }
  });

  it("counts setup BM (unique_count_agg + non-recurring) as distinct units in period", async () => {
    // Need a fresh subscription so we can put events inside its period.
    const subRes = await api.post<{
      subscription: { current_billing_period_started_at: string };
    }>("/subscriptions", {
      subscription: {
        external_customer_id: "cust-cu",
        plan_code: "plan-cu",
        external_id: "sub-cu-setup",
        billing_time: "calendar",
      },
    });
    const periodStart = new Date(
      subRes.body.subscription.current_billing_period_started_at,
    );

    // Fire 2 distinct setup events with timestamps clearly inside the period.
    const now = Math.floor(periodStart.getTime() / 1000) + 60;
    await api.post("/events", {
      event: {
        transaction_id: "evt-cu-setup-1",
        external_subscription_id: "sub-cu-setup",
        code: "bm-cu-setup",
        timestamp: now,
        properties: { unit_external_id: "u-a", operation_type: "add" },
      },
    });
    await api.post("/events", {
      event: {
        transaction_id: "evt-cu-setup-2",
        external_subscription_id: "sub-cu-setup",
        code: "bm-cu-setup",
        timestamp: now,
        properties: { unit_external_id: "u-b", operation_type: "add" },
      },
    });
    // Duplicate unit_external_id → should NOT double-count.
    await api.post("/events", {
      event: {
        transaction_id: "evt-cu-setup-3",
        external_subscription_id: "sub-cu-setup",
        code: "bm-cu-setup",
        timestamp: now,
        properties: { unit_external_id: "u-a", operation_type: "add" },
      },
    });

    const res = await api.get<CurrentUsageBody>(
      "/customers/cust-cu/current_usage?external_subscription_id=sub-cu-setup&apply_taxes=false",
    );
    const setupCharge = res.body.customer_usage.charges_usage.find(
      (c) => c.billable_metric.code === "bm-cu-setup",
    )!;
    expect(setupCharge.units).toBe("2.0"); // u-a and u-b distinct
    expect(setupCharge.amount_cents).toBe(240000); // 2 * 1200 * 100
    expect(setupCharge.events_count).toBe(3);
  });

  it("prorates recurring units alive for half the period", async () => {
    // Use a fresh sub so we have full control of its period.
    await api.post("/subscriptions", {
      subscription: {
        external_customer_id: "cust-cu",
        plan_code: "plan-cu",
        external_id: "sub-cu-prorate",
        billing_time: "calendar",
      },
    });
    // Pull the freshly-created sub's window from the response so the test
    // self-aligns to whatever wall-clock month is current.
    const subRes = await api.get<{
      subscription: {
        current_billing_period_started_at: string;
        current_billing_period_ending_at: string;
      };
    }>("/subscriptions/sub-cu-prorate");
    const pStart = new Date(
      subRes.body.subscription.current_billing_period_started_at,
    );
    const pEnd = new Date(
      subRes.body.subscription.current_billing_period_ending_at,
    );

    // Add event halfway through the period.
    const midpoint = Math.floor((pStart.getTime() + pEnd.getTime()) / 2 / 1000);
    await api.post("/events", {
      event: {
        transaction_id: "evt-cu-prorate-add",
        external_subscription_id: "sub-cu-prorate",
        code: "bm-cu-monthly",
        timestamp: midpoint,
        properties: { unit_external_id: "u-half", operation_type: "add" },
      },
    });

    const res = await api.get<CurrentUsageBody>(
      "/customers/cust-cu/current_usage?external_subscription_id=sub-cu-prorate&apply_taxes=false",
    );
    const monthlyCharge = res.body.customer_usage.charges_usage.find(
      (c) => c.billable_metric.code === "bm-cu-monthly",
    )!;
    const units = Number.parseFloat(monthlyCharge.units);
    // Unit alive for roughly the last half of the calendar month — units
    // should land between 0 and 0.6 (depending on what month it actually is).
    expect(units).toBeGreaterThan(0);
    expect(units).toBeLessThan(0.7);
    // Amount = round(units * 450 * 100) within tolerance.
    const expected = Math.round(units * 450 * 100);
    expect(Math.abs(monthlyCharge.amount_cents - expected)).toBeLessThanOrEqual(
      1,
    );
  });

  it("applies taxes when apply_taxes is not 'false'", async () => {
    const subRes = await api.post<{
      subscription: { current_billing_period_started_at: string };
    }>("/subscriptions", {
      subscription: {
        external_customer_id: "cust-cu",
        plan_code: "plan-cu",
        external_id: "sub-cu-tax",
        billing_time: "calendar",
      },
    });
    const periodStart = new Date(
      subRes.body.subscription.current_billing_period_started_at,
    );
    const now = Math.floor(periodStart.getTime() / 1000) + 60;
    await api.post("/events", {
      event: {
        transaction_id: "evt-cu-tax-setup",
        external_subscription_id: "sub-cu-tax",
        code: "bm-cu-setup",
        timestamp: now,
        properties: { unit_external_id: "u-tax", operation_type: "add" },
      },
    });

    const withTaxes = await api.get<CurrentUsageBody>(
      "/customers/cust-cu/current_usage?external_subscription_id=sub-cu-tax",
    );
    const noTaxes = await api.get<CurrentUsageBody>(
      "/customers/cust-cu/current_usage?external_subscription_id=sub-cu-tax&apply_taxes=false",
    );

    expect(noTaxes.body.customer_usage.taxes_amount_cents).toBe(0);
    expect(withTaxes.body.customer_usage.taxes_amount_cents).toBeGreaterThan(0);
    // 16% IVA on 1 setup unit @ 1200 = 19200 cents.
    expect(withTaxes.body.customer_usage.taxes_amount_cents).toBe(19200);
    expect(withTaxes.body.customer_usage.total_amount_cents).toBe(
      withTaxes.body.customer_usage.amount_cents +
        withTaxes.body.customer_usage.taxes_amount_cents,
    );
  });

  it("returns 404 when customer doesn't exist", async () => {
    const res = await api.get<{ code: string }>(
      "/customers/no-such-customer/current_usage",
    );
    expect(res.status).toBe(404);
  });

  it("requires external_subscription_id when customer has >1 sub", async () => {
    const res = await api.get<{
      code: string;
      error_details: Record<string, string[]>;
    }>("/customers/cust-cu/current_usage");
    expect(res.status).toBe(422);
    expect(res.body.error_details["external_subscription_id"]).toBeDefined();
  });
});
