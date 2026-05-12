import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestHarness } from "../helpers/server.js";
import { TestClient } from "../helpers/http.js";

type Charge = {
  lago_id: string;
  lago_billable_metric_id: string;
  billable_metric_code: string;
  invoice_display_name: string | null;
  charge_model: string;
  invoiceable: boolean;
  prorated: boolean;
  pay_in_advance: boolean;
  min_amount_cents: number;
  properties: Record<string, unknown>;
  filters: unknown[];
  taxes: unknown[];
  regroup_paid_fees: null;
};

type Plan = {
  lago_id: string;
  name: string;
  code: string;
  interval: string;
  description: string | null;
  amount_cents: number;
  amount_currency: string;
  pay_in_advance: boolean;
  bill_charges_monthly: boolean | null;
  trial_period: number | null;
  invoice_display_name: string | null;
  charges: Charge[];
  customers_count: number;
  active_subscriptions_count: number;
  draft_invoices_count: number;
  parent_id: string | null;
  usage_thresholds: unknown[];
  taxes: unknown[];
};

type PlanBody = { plan: Plan };

async function createRecurringBm(api: TestClient, code: string): Promise<string> {
  const res = await api.post<{ billable_metric: { lago_id: string } }>(
    "/billable_metrics",
    {
      billable_metric: {
        name: `BM ${code}`,
        code,
        aggregation_type: "unique_count_agg",
        field_name: "unit_external_id",
        recurring: true,
      },
    },
  );
  return res.body.billable_metric.lago_id;
}

async function createNonRecurringBm(
  api: TestClient,
  code: string,
): Promise<string> {
  const res = await api.post<{ billable_metric: { lago_id: string } }>(
    "/billable_metrics",
    {
      billable_metric: {
        name: `BM ${code}`,
        code,
        aggregation_type: "unique_count_agg",
        field_name: "unit_external_id",
        recurring: false,
      },
    },
  );
  return res.body.billable_metric.lago_id;
}

describe("plans", () => {
  let harness: TestHarness;
  let api: TestClient;

  beforeAll(async () => {
    harness = await startTestServer();
    api = new TestClient(harness.baseUrl, harness.apiKey);
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("creates a plan with prorated and non-prorated charges", async () => {
    const monthlyBmId = await createRecurringBm(api, "bm_recurring_1");
    const setupBmId = await createNonRecurringBm(api, "bm_setup_1");

    const res = await api.post<PlanBody>("/plans", {
      plan: {
        name: "Combustible Plan",
        code: "plan_1",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
        pay_in_advance: false,
        bill_charges_monthly: false,
        charges: [
          {
            billable_metric_id: monthlyBmId,
            charge_model: "standard",
            prorated: true,
            invoiceable: true,
            invoice_display_name: "Servicio",
            properties: { amount: "450.00" },
          },
          {
            billable_metric_id: setupBmId,
            charge_model: "standard",
            prorated: false,
            invoiceable: true,
            invoice_display_name: "Setup",
            properties: { amount: "1200.00" },
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    const plan = res.body.plan;
    expect(plan.code).toBe("plan_1");
    // bill_charges_monthly is normalised to null when interval=monthly
    expect(plan.bill_charges_monthly).toBeNull();
    expect(plan.charges).toHaveLength(2);
    const monthlyCharge = plan.charges.find((c) => c.prorated)!;
    expect(monthlyCharge.lago_billable_metric_id).toBe(monthlyBmId);
    expect(monthlyCharge.billable_metric_code).toBe("bm_recurring_1");
    expect(monthlyCharge.properties["amount"]).toBe("450.00");
    expect(monthlyCharge.regroup_paid_fees).toBeNull();
    expect(monthlyCharge.min_amount_cents).toBe(0);
  });

  it("rejects prorated:true on a non-recurring BM with 422", async () => {
    const bmId = await createNonRecurringBm(api, "bm_nonrec_for_prorated");
    const res = await api.post<{
      code: string;
      error: string;
      error_details: Record<string, string[]>;
    }>("/plans", {
      plan: {
        name: "Bad",
        code: "plan_bad_prorated",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
        charges: [
          {
            billable_metric_id: bmId,
            charge_model: "standard",
            prorated: true,
            properties: { amount: "100.00" },
          },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
    expect(res.body.error).toBe(
      "prorated charges require a recurring billable metric",
    );
    expect(res.body.error_details["charges.0.prorated"]).toEqual([
      "value_is_invalid",
    ]);
  });

  it("rejects unknown billable_metric_id with 422", async () => {
    const res = await api.post<{
      code: string;
      error_details: Record<string, string[]>;
    }>("/plans", {
      plan: {
        name: "Bad",
        code: "plan_unknown_bm",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
        charges: [
          {
            billable_metric_id: "00000000-0000-0000-0000-000000000000",
            charge_model: "standard",
            properties: { amount: "100.00" },
          },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.error_details["charges.0.billable_metric_id"]).toEqual([
      "value_is_invalid",
    ]);
  });

  it("rejects charge_model other than 'standard' (D8)", async () => {
    const bmId = await createRecurringBm(api, "bm_for_bad_model");
    const res = await api.post<{ code: string }>("/plans", {
      plan: {
        name: "Bad",
        code: "plan_bad_model",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
        charges: [
          {
            billable_metric_id: bmId,
            charge_model: "graduated",
            properties: { amount: "100.00" },
          },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
  });

  it("returns 422 value_already_exist on duplicate code", async () => {
    await api.post("/plans", {
      plan: {
        name: "Dup",
        code: "plan_dup",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
      },
    });
    const second = await api.post<{
      error_details: Record<string, string[]>;
    }>("/plans", {
      plan: {
        name: "Dup2",
        code: "plan_dup",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
      },
    });
    expect(second.status).toBe(422);
    expect(second.body.error_details).toEqual({
      code: ["value_already_exist"],
    });
  });

  it("keeps bill_charges_monthly literal for yearly intervals", async () => {
    const res = await api.post<PlanBody>("/plans", {
      plan: {
        name: "Yearly",
        code: "plan_yearly",
        interval: "yearly",
        amount_cents: 100000,
        amount_currency: "USD",
        bill_charges_monthly: true,
      },
    });
    expect(res.body.plan.bill_charges_monthly).toBe(true);
  });

  it("normalises amount to 2 decimals", async () => {
    const bmId = await createRecurringBm(api, "bm_for_amount_norm");
    const res = await api.post<PlanBody>("/plans", {
      plan: {
        name: "Norm",
        code: "plan_norm_amount",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
        charges: [
          {
            billable_metric_id: bmId,
            charge_model: "standard",
            // Sent as a plain number; should normalise to "450.00".
            properties: { amount: 450 },
          },
        ],
      },
    });
    expect(res.body.plan.charges[0]!.properties["amount"]).toBe("450.00");
  });

  it("retrieves a plan by code with charges embedded", async () => {
    const bmId = await createRecurringBm(api, "bm_for_get");
    await api.post("/plans", {
      plan: {
        name: "Get me",
        code: "plan_get",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
        charges: [
          {
            billable_metric_id: bmId,
            charge_model: "standard",
            properties: { amount: "10.00" },
          },
        ],
      },
    });
    const res = await api.get<PlanBody>("/plans/plan_get");
    expect(res.status).toBe(200);
    expect(res.body.plan.charges).toHaveLength(1);
    expect(res.body.plan.charges[0]!.lago_billable_metric_id).toBe(bmId);
  });

  it("returns 404 for unknown plan", async () => {
    const res = await api.get<{ code: string }>("/plans/missing");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("plan_not_found");
  });

  it("updates plan-level fields via PUT", async () => {
    await api.post("/plans", {
      plan: {
        name: "Initial",
        code: "plan_put",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
        description: "v1",
      },
    });
    const upd = await api.put<PlanBody>("/plans/plan_put", {
      plan: { description: "v2" },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.plan.description).toBe("v2");
    expect(upd.body.plan.name).toBe("Initial");
  });

  it("soft-deletes a plan", async () => {
    await api.post("/plans", {
      plan: {
        name: "Del",
        code: "plan_del",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
      },
    });
    const del = await api.delete<PlanBody>("/plans/plan_del");
    expect(del.status).toBe(200);
    const after = await api.get<{ code: string }>("/plans/plan_del");
    expect(after.status).toBe(404);
  });
});
