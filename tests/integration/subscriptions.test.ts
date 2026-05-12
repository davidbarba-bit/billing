import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestHarness } from "../helpers/server.js";
import { TestClient } from "../helpers/http.js";

type Subscription = {
  lago_id: string;
  external_id: string;
  external_customer_id: string;
  plan_code: string;
  status: string;
  billing_time: string;
  subscription_at: string;
  started_at: string | null;
  current_billing_period_started_at: string | null;
  current_billing_period_ending_at: string | null;
  terminated_at: string | null;
  plan?: { code: string; charges: unknown[] };
};

type SubBody = { subscription: Subscription };

async function setupCustomerAndPlan(api: TestClient, tz: string | null = "America/Mexico_City") {
  await api.post("/customers", {
    customer: { external_id: "cust-1", currency: "MXN", ...(tz ? { timezone: tz } : {}) },
  });
  const bmRes = await api.post<{ billable_metric: { lago_id: string } }>(
    "/billable_metrics",
    {
      billable_metric: {
        name: "BM",
        code: "bm-sub-1",
        aggregation_type: "unique_count_agg",
        field_name: "unit_external_id",
        recurring: true,
      },
    },
  );
  await api.post("/plans", {
    plan: {
      name: "Plan",
      code: "plan-sub-1",
      interval: "monthly",
      amount_cents: 0,
      amount_currency: "MXN",
      charges: [
        {
          billable_metric_id: bmRes.body.billable_metric.lago_id,
          charge_model: "standard",
          prorated: true,
          properties: { amount: "450.00" },
        },
      ],
    },
  });
}

describe("subscriptions", () => {
  let harness: TestHarness;
  let api: TestClient;

  beforeAll(async () => {
    harness = await startTestServer();
    api = new TestClient(harness.baseUrl, harness.apiKey);
    await setupCustomerAndPlan(api);
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("creates a calendar subscription with status=active and tz-aware period end", async () => {
    const res = await api.post<SubBody>("/subscriptions", {
      subscription: {
        external_customer_id: "cust-1",
        plan_code: "plan-sub-1",
        external_id: "sub-cal-1",
        name: "Calendar",
        billing_time: "calendar",
      },
    });
    expect(res.status).toBe(200);
    const s = res.body.subscription;
    expect(s.status).toBe("active");
    expect(s.billing_time).toBe("calendar");
    expect(s.started_at).not.toBeNull();
    expect(s.current_billing_period_started_at).toBe(s.started_at);

    // End-of-month in CDMX (UTC-6) → next-month-01T06:00:00Z minus 1s.
    const end = new Date(s.current_billing_period_ending_at!);
    const wall = new Date(end.getTime() + 1000); // +1s = next-month-start UTC
    expect(wall.getUTCHours()).toBe(6);
    expect(wall.getUTCMinutes()).toBe(0);
    expect(wall.getUTCSeconds()).toBe(0);
    expect(wall.getUTCDate()).toBe(1);

    // plan embed present in POST response.
    expect(s.plan?.code).toBe("plan-sub-1");
  });

  it("creates an anniversary subscription with future subscription_at as pending", async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // +30 days
    const res = await api.post<SubBody>("/subscriptions", {
      subscription: {
        external_customer_id: "cust-1",
        plan_code: "plan-sub-1",
        external_id: "sub-anniv-future",
        name: "Future",
        billing_time: "anniversary",
        subscription_at: future.toISOString(),
      },
    });
    expect(res.status).toBe(200);
    const s = res.body.subscription;
    expect(s.status).toBe("pending");
    expect(s.started_at).toBeNull();
    expect(s.current_billing_period_started_at).toBeNull();
    expect(s.current_billing_period_ending_at).toBeNull();
  });

  it("creates an anniversary subscription with past subscription_at as active", async () => {
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // -5 days
    const res = await api.post<SubBody>("/subscriptions", {
      subscription: {
        external_customer_id: "cust-1",
        plan_code: "plan-sub-1",
        external_id: "sub-anniv-past",
        billing_time: "anniversary",
        subscription_at: past.toISOString(),
      },
    });
    expect(res.body.subscription.status).toBe("active");
    expect(res.body.subscription.current_billing_period_started_at).not.toBeNull();
  });

  it("requires subscription_at for anniversary billing", async () => {
    const res = await api.post<{
      code: string;
      error_details: Record<string, string[]>;
    }>("/subscriptions", {
      subscription: {
        external_customer_id: "cust-1",
        plan_code: "plan-sub-1",
        external_id: "sub-bad",
        billing_time: "anniversary",
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.error_details["subscription_at"]).toBeDefined();
  });

  it("rejects unknown plan_code with 422", async () => {
    const res = await api.post<{
      code: string;
      error_details: Record<string, string[]>;
    }>("/subscriptions", {
      subscription: {
        external_customer_id: "cust-1",
        plan_code: "nope",
        external_id: "sub-bad-plan",
        billing_time: "calendar",
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.error_details["plan_code"]).toEqual(["value_is_invalid"]);
  });

  it("rejects unknown external_customer_id with 422", async () => {
    const res = await api.post<{
      code: string;
      error_details: Record<string, string[]>;
    }>("/subscriptions", {
      subscription: {
        external_customer_id: "nope",
        plan_code: "plan-sub-1",
        external_id: "sub-bad-cust",
        billing_time: "calendar",
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.error_details["external_customer_id"]).toEqual([
      "value_is_invalid",
    ]);
  });

  it("rejects duplicate external_id with 422", async () => {
    await api.post("/subscriptions", {
      subscription: {
        external_customer_id: "cust-1",
        plan_code: "plan-sub-1",
        external_id: "sub-dup",
        billing_time: "calendar",
      },
    });
    const dup = await api.post<{ error_details: Record<string, string[]> }>(
      "/subscriptions",
      {
        subscription: {
          external_customer_id: "cust-1",
          plan_code: "plan-sub-1",
          external_id: "sub-dup",
          billing_time: "calendar",
        },
      },
    );
    expect(dup.status).toBe(422);
    expect(dup.body.error_details).toEqual({
      external_id: ["value_already_exist"],
    });
  });

  it("retrieves a subscription by external_id with plan embedded", async () => {
    await api.post("/subscriptions", {
      subscription: {
        external_customer_id: "cust-1",
        plan_code: "plan-sub-1",
        external_id: "sub-get",
        billing_time: "calendar",
      },
    });
    const res = await api.get<SubBody>("/subscriptions/sub-get");
    expect(res.status).toBe(200);
    expect(res.body.subscription.plan?.code).toBe("plan-sub-1");
  });

  it("lists subscriptions by external_customer_id WITHOUT plan embed", async () => {
    const res = await api.get<{
      subscriptions: Subscription[];
      meta: { current_page: number };
    }>("/subscriptions?external_customer_id=cust-1");
    expect(res.status).toBe(200);
    expect(res.body.subscriptions.length).toBeGreaterThan(0);
    for (const s of res.body.subscriptions) {
      expect(s.plan).toBeUndefined();
    }
  });

  it("DELETE on active sub terminates it", async () => {
    await api.post("/subscriptions", {
      subscription: {
        external_customer_id: "cust-1",
        plan_code: "plan-sub-1",
        external_id: "sub-del-active",
        billing_time: "calendar",
      },
    });
    const del = await api.delete<SubBody>("/subscriptions/sub-del-active");
    expect(del.status).toBe(200);
    expect(del.body.subscription.status).toBe("terminated");
    expect(del.body.subscription.terminated_at).not.toBeNull();
  });

  it("DELETE on pending sub without ?status=pending returns 404", async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await api.post("/subscriptions", {
      subscription: {
        external_customer_id: "cust-1",
        plan_code: "plan-sub-1",
        external_id: "sub-del-pending",
        billing_time: "anniversary",
        subscription_at: future.toISOString(),
      },
    });
    const del = await api.delete<{ code: string }>(
      "/subscriptions/sub-del-pending",
    );
    expect(del.status).toBe(404);
  });

  it("DELETE on pending sub with ?status=pending cancels it", async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await api.post("/subscriptions", {
      subscription: {
        external_customer_id: "cust-1",
        plan_code: "plan-sub-1",
        external_id: "sub-del-pending-ok",
        billing_time: "anniversary",
        subscription_at: future.toISOString(),
      },
    });
    const del = await api.delete<SubBody>(
      "/subscriptions/sub-del-pending-ok?status=pending",
    );
    expect(del.status).toBe(200);
    expect(del.body.subscription.status).toBe("canceled");
  });

  it("UTC customer gets UTC period boundaries (cascade fallback)", async () => {
    await api.post("/customers", {
      customer: { external_id: "cust-utc" },
    });
    const res = await api.post<SubBody>("/subscriptions", {
      subscription: {
        external_customer_id: "cust-utc",
        plan_code: "plan-sub-1",
        external_id: "sub-utc",
        billing_time: "calendar",
      },
    });
    const end = new Date(res.body.subscription.current_billing_period_ending_at!);
    // UTC end-of-month: last second of month, hour 23
    expect(end.getUTCHours()).toBe(23);
    expect(end.getUTCMinutes()).toBe(59);
    expect(end.getUTCSeconds()).toBe(59);
  });
});
