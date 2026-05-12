import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestHarness } from "../helpers/server.js";
import { TestClient } from "../helpers/http.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "lago-pairs",
);

async function loadJson<T = unknown>(filename: string): Promise<T> {
  const raw = await readFile(join(FIXTURES, filename), "utf8");
  return JSON.parse(raw) as T;
}

/**
 * Fields the mini-Lago server cannot reproduce identically against the
 * captured production response. We compare the remainder field-for-field.
 */
const VOLATILE_KEYS = new Set([
  "lago_id",
  "lago_customer_id",
  "lago_subscription_id",
  "lago_billable_metric_id",
  "lago_item_id",
  "created_at",
  "updated_at",
  "sequential_id",
  "slug",
  "issuing_date",
  "from_datetime",
  "to_datetime",
  "subscription_at",
  "current_billing_period_started_at",
  "current_billing_period_ending_at",
  "started_at",
  "customers_count",
  "active_subscriptions_count",
  "draft_invoices_count",
]);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

describe("fixture replay — golden bytes from Numaris → Lago Cloud", () => {
  let harness: TestHarness;
  let api: TestClient;

  beforeAll(async () => {
    harness = await startTestServer();
    api = new TestClient(harness.baseUrl, harness.apiKey);
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("03 — POST /taxes creates the canonical IVA tax", async () => {
    const req = await loadJson("03-taxes-create.request.json");
    const expected = await loadJson<{ tax: Record<string, unknown> }>(
      "03-taxes-create.response.json",
    );

    const res = await api.post<{ tax: Record<string, unknown> }>("/taxes", req);
    expect(res.status).toBe(200);

    const actual = stripVolatile(res.body) as { tax: Record<string, unknown> };
    const want = stripVolatile(expected) as { tax: Record<string, unknown> };
    expect(actual).toEqual(want);
  });

  it("03 — POST /taxes duplicate returns 422 + value_already_exist", async () => {
    const req = await loadJson("03-taxes-create.request.json");
    const expected422 = await loadJson(
      "03-taxes-create-duplicate.response.json",
    );

    // Ensure the tax exists.
    await api.post("/taxes", req);

    const res = await api.post("/taxes", req);
    expect(res.status).toBe(422);
    expect(res.body).toEqual(expected422);
  });

  it("01a — POST /customers (create) returns the canonical customer shape", async () => {
    // Tax must exist first (Numaris invokes ensureIvaTax() before createCustomer).
    await api.post("/taxes", await loadJson("03-taxes-create.request.json"));

    const req = await loadJson("01a-customers-create.request.json");
    const expected = await loadJson<{ customer: Record<string, unknown> }>(
      "01a-customers-create.response.json",
    );

    const res = await api.post<{ customer: Record<string, unknown> }>(
      "/customers",
      req,
    );
    expect(res.status).toBe(200);

    const actual = stripVolatile(res.body) as {
      customer: Record<string, unknown>;
    };
    const want = stripVolatile(expected) as {
      customer: Record<string, unknown>;
    };
    expect(actual).toEqual(want);
  });

  it("01b — POST /customers (upsert) merges the email but preserves the rest", async () => {
    // Setup: tax + initial customer.
    await api.post("/taxes", await loadJson("03-taxes-create.request.json"));
    await api.post(
      "/customers",
      await loadJson("01a-customers-create.request.json"),
    );

    const upsertReq = await loadJson("01b-customers-upsert.request.json");
    const expected = await loadJson<{ customer: Record<string, unknown> }>(
      "01b-customers-upsert.response.json",
    );

    const res = await api.post<{ customer: Record<string, unknown> }>(
      "/customers",
      upsertReq,
    );
    expect(res.status).toBe(200);

    // Email is the only field that changed; tax_identification_number,
    // currency, country, taxes[], etc. must still be there from the create.
    const customer = res.body.customer;
    expect(customer["email"]).toBe(
      "facturacion@carga-express-mx-capture.test",
    );
    expect(customer["tax_identification_number"]).toBe("CEM250101AAA");
    expect(customer["currency"]).toBe("MXN");
    expect(customer["country"]).toBe("MX");
    expect((customer["taxes"] as unknown[]).length).toBe(1);

    const actual = stripVolatile(customer);
    const want = stripVolatile(expected.customer);
    expect(actual).toEqual(want);
  });

  it("02 — GET /customers/:external_id matches the canonical shape", async () => {
    await api.post("/taxes", await loadJson("03-taxes-create.request.json"));
    await api.post(
      "/customers",
      await loadJson("01a-customers-create.request.json"),
    );

    const expected = await loadJson<{ customer: Record<string, unknown> }>(
      "02-customers-get.response.json",
    );

    const res = await api.get<{ customer: Record<string, unknown> }>(
      "/customers/carga-express-mx",
    );
    expect(res.status).toBe(200);

    // The captured GET has timezone=null/applicable_timezone="UTC" but our
    // create fixture sent timezone="America/Mexico_City"; both are valid Lago
    // shapes (the GET row was older). We assert all customer keys exist and
    // the stable ones match.
    const customer = res.body.customer;
    for (const key of Object.keys(expected.customer)) {
      expect(customer).toHaveProperty(key);
    }
    expect(customer["external_id"]).toBe("carga-express-mx");
    expect(customer["tax_identification_number"]).toBe("CEM250101AAA");
  });

  it("09a — POST /add_ons (mensual) returns the canonical add-on shape", async () => {
    const req = await loadJson("09a-addons-monthly.request.json");
    const expected = await loadJson<{ add_on: Record<string, unknown> }>(
      "09a-addons-monthly.response.json",
    );

    const res = await api.post<{ add_on: Record<string, unknown> }>(
      "/add_ons",
      req,
    );
    expect(res.status).toBe(200);

    const actual = stripVolatile(res.body) as {
      add_on: Record<string, unknown>;
    };
    const want = stripVolatile(expected) as {
      add_on: Record<string, unknown>;
    };
    expect(actual).toEqual(want);
  });

  it("09b — POST /add_ons (setup) returns the canonical add-on shape", async () => {
    const req = await loadJson("09b-addons-setup.request.json");
    const expected = await loadJson<{ add_on: Record<string, unknown> }>(
      "09b-addons-setup.response.json",
    );

    const res = await api.post<{ add_on: Record<string, unknown> }>(
      "/add_ons",
      req,
    );
    expect(res.status).toBe(200);

    const actual = stripVolatile(res.body) as {
      add_on: Record<string, unknown>;
    };
    const want = stripVolatile(expected) as {
      add_on: Record<string, unknown>;
    };
    expect(actual).toEqual(want);
  });

  it("10 — GET /add_ons/:code matches the canonical shape", async () => {
    await api.post("/add_ons", await loadJson("09a-addons-monthly.request.json"));
    const expected = await loadJson<{ add_on: Record<string, unknown> }>(
      "10-addons-get.response.json",
    );

    const res = await api.get<{ add_on: Record<string, unknown> }>(
      "/add_ons/cobro-carga-express-mx-combustible",
    );
    expect(res.status).toBe(200);

    const actual = stripVolatile(res.body) as {
      add_on: Record<string, unknown>;
    };
    const want = stripVolatile(expected) as {
      add_on: Record<string, unknown>;
    };
    expect(actual).toEqual(want);
  });

  it("06 — POST /plans with prorated charge matches canonical shape", async () => {
    // Fixture uses fixed BM UUIDs that don't exist locally; create BMs first
    // and rewrite the charge ids to point at our locally-minted BMs.
    const monthlyBm = await api.post<{
      billable_metric: { lago_id: string };
    }>("/billable_metrics", {
      billable_metric: {
        name: "Unidades activas — Combustible",
        code: "bm-carga-express-mx-combustible-7be0a53d",
        aggregation_type: "unique_count_agg",
        field_name: "unit_external_id",
        recurring: true,
      },
    });
    const setupBm = await api.post<{
      billable_metric: { lago_id: string };
    }>("/billable_metrics", {
      billable_metric: {
        name: "Instalaciones nuevas — Combustible",
        code: "bm-setup-carga-express-mx-combustible-0c46b355",
        aggregation_type: "unique_count_agg",
        field_name: "unit_external_id",
        recurring: false,
      },
    });

    const req = await loadJson<{
      plan: { charges: Array<{ billable_metric_id: string }> };
    }>("06-plans-create.request.json");
    req.plan.charges[0]!.billable_metric_id = monthlyBm.body.billable_metric.lago_id;
    req.plan.charges[1]!.billable_metric_id = setupBm.body.billable_metric.lago_id;

    const expected = await loadJson<{ plan: Record<string, unknown> }>(
      "06-plans-create.response.json",
    );

    const res = await api.post<{ plan: Record<string, unknown> }>("/plans", req);
    expect(res.status).toBe(200);

    const actual = stripVolatile(res.body) as { plan: Record<string, unknown> };
    const want = stripVolatile(expected) as { plan: Record<string, unknown> };
    expect(actual).toEqual(want);
  });

  it("07a — POST /subscriptions anniversary (future) → pending", async () => {
    // Setup: tax, customer, BMs, plan.
    await api.post("/taxes", await loadJson("03-taxes-create.request.json"));
    await api.post(
      "/customers",
      await loadJson("01a-customers-create.request.json"),
    );
    // BMs and plan may have been created by an earlier fixture test in this
    // file; fall back to GET when create returns 422 value_already_exist.
    const ensureBm = async (
      code: string,
      recurring: boolean,
    ): Promise<string> => {
      const got = await api.get<{ billable_metric: { lago_id: string } }>(
        `/billable_metrics/${code}`,
      );
      if (got.status === 200) return got.body.billable_metric.lago_id;
      const made = await api.post<{ billable_metric: { lago_id: string } }>(
        "/billable_metrics",
        {
          billable_metric: {
            name: code,
            code,
            aggregation_type: "unique_count_agg",
            field_name: "unit_external_id",
            recurring,
          },
        },
      );
      return made.body.billable_metric.lago_id;
    };
    const monthlyId = await ensureBm(
      "bm-carga-express-mx-combustible-7be0a53d",
      true,
    );
    const setupId = await ensureBm(
      "bm-setup-carga-express-mx-combustible-0c46b355",
      false,
    );

    const planCode = "plan-carga-express-mx-combustible-79844679";
    const existingPlan = await api.get(`/plans/${planCode}`);
    if (existingPlan.status !== 200) {
      const planReq = await loadJson<{
        plan: { charges: Array<{ billable_metric_id: string }> };
      }>("06-plans-create.request.json");
      planReq.plan.charges[0]!.billable_metric_id = monthlyId;
      planReq.plan.charges[1]!.billable_metric_id = setupId;
      await api.post("/plans", planReq);
    }

    // Move the captured `subscription_at` into the future to keep status:pending.
    const subReq = await loadJson<{
      subscription: { subscription_at: string };
    }>("07a-subscriptions-anniversary.request.json");
    subReq.subscription.subscription_at = new Date(
      Date.now() + 60 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const res = await api.post<{ subscription: Record<string, unknown> }>(
      "/subscriptions",
      subReq,
    );
    expect(res.status).toBe(200);
    expect(res.body.subscription["status"]).toBe("pending");
    expect(res.body.subscription["billing_time"]).toBe("anniversary");
    expect(res.body.subscription["started_at"]).toBeNull();
    expect(res.body.subscription["current_billing_period_started_at"]).toBeNull();
    // Plan embed present, matches the captured shape.
    const planEmbed = res.body.subscription["plan"] as Record<string, unknown>;
    expect(planEmbed["code"]).toBe(
      "plan-carga-express-mx-combustible-79844679",
    );
    expect((planEmbed["charges"] as unknown[]).length).toBe(2);
  });

  it("04 — POST /events (add) returns the canonical event shape", async () => {
    // Setup: customer + BM + plan + subscription matching the fixture's sub id.
    await api.post("/customers", {
      customer: { external_id: "carga-express-mx", currency: "MXN", timezone: "UTC" },
    });
    await api.post("/billable_metrics", {
      billable_metric: {
        name: "Unidades activas — Combustible",
        code: "bm-carga-express-mx-combustible-7be0a53d",
        aggregation_type: "unique_count_agg",
        field_name: "unit_external_id",
        recurring: true,
      },
    });
    const bm = await api.get<{ billable_metric: { lago_id: string } }>(
      "/billable_metrics/bm-carga-express-mx-combustible-7be0a53d",
    );
    await api.post("/plans", {
      plan: {
        name: "Plan",
        code: "plan-events-replay",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "MXN",
        charges: [
          {
            billable_metric_id: bm.body.billable_metric.lago_id,
            charge_model: "standard",
            prorated: true,
            properties: { amount: "450.00" },
          },
        ],
      },
    });
    await api.post("/subscriptions", {
      subscription: {
        external_customer_id: "carga-express-mx",
        plan_code: "plan-events-replay",
        external_id: "sub-carga-express-mx-combustible-a681d853",
        billing_time: "calendar",
      },
    });

    const req = await loadJson<{
      event: { timestamp: number; transaction_id: string };
    }>("04-events-add.request.json");
    const res = await api.post<{ event: Record<string, unknown> }>(
      "/events",
      req,
    );
    expect(res.status).toBe(200);
    const e = res.body.event;
    expect(e["transaction_id"]).toBe(req.event.transaction_id);
    expect(e["external_subscription_id"]).toBe(
      "sub-carga-express-mx-combustible-a681d853",
    );
    expect(e["code"]).toBe("bm-carga-express-mx-combustible-7be0a53d");
    expect(e["lago_customer_id"]).toBeNull();
    expect(e["lago_subscription_id"]).toBeNull();
    expect(e["precise_total_amount_cents"]).toBeNull();
    // Server normalises epoch seconds to ISO in the response.
    expect(typeof e["timestamp"]).toBe("string");
    expect(new Date(e["timestamp"] as string).getTime()).toBe(
      req.event.timestamp * 1000,
    );
  });

  it("05 — POST /events (remove) processes the remove and returns ISO timestamp", async () => {
    // Reuses the setup from 04. If 04 didn't run, do an idempotent setup.
    const getCust = await api.get("/customers/carga-express-mx");
    if (getCust.status !== 200) {
      await api.post("/customers", {
        customer: {
          external_id: "carga-express-mx",
          currency: "MXN",
          timezone: "UTC",
        },
      });
    }
    const getBm = await api.get(
      "/billable_metrics/bm-carga-express-mx-combustible-7be0a53d",
    );
    if (getBm.status !== 200) {
      await api.post("/billable_metrics", {
        billable_metric: {
          name: "Unidades activas — Combustible",
          code: "bm-carga-express-mx-combustible-7be0a53d",
          aggregation_type: "unique_count_agg",
          field_name: "unit_external_id",
          recurring: true,
        },
      });
    }

    const req = await loadJson<{ event: { timestamp: number } }>(
      "05-events-remove.request.json",
    );
    const res = await api.post<{ event: Record<string, unknown> }>(
      "/events",
      req,
    );
    expect(res.status).toBe(200);
    expect(res.body.event["lago_customer_id"]).toBeNull();
    expect(res.body.event["lago_subscription_id"]).toBeNull();
  });

  it("08 — GET /current_usage with no events returns zero-usage canonical shape", async () => {
    // Setup matching the fixture: customer with calendar sub, no events.
    await api.post("/customers", {
      customer: {
        external_id: "carga-express-mx",
        currency: "MXN",
        timezone: "UTC",
      },
    });
    const monthlyBmRes = await api.get<{
      billable_metric: { lago_id: string };
    }>("/billable_metrics/bm-carga-express-mx-combustible-7be0a53d");
    if (monthlyBmRes.status !== 200) {
      await api.post("/billable_metrics", {
        billable_metric: {
          name: "Unidades activas — Combustible",
          code: "bm-carga-express-mx-combustible-7be0a53d",
          aggregation_type: "unique_count_agg",
          field_name: "unit_external_id",
          recurring: true,
        },
      });
    }
    await api.post("/billable_metrics", {
      billable_metric: {
        name: "Instalaciones nuevas — Combustible",
        code: "bm-setup-carga-express-mx-combustible-0c46b355",
        aggregation_type: "unique_count_agg",
        field_name: "unit_external_id",
        recurring: false,
      },
    });
    const monthlyBm = await api.get<{
      billable_metric: { lago_id: string };
    }>("/billable_metrics/bm-carga-express-mx-combustible-7be0a53d");
    const setupBm = await api.get<{
      billable_metric: { lago_id: string };
    }>("/billable_metrics/bm-setup-carga-express-mx-combustible-0c46b355");
    const existingPlan = await api.get(
      "/plans/plan-carga-express-mx-combustible-79844679",
    );
    if (existingPlan.status !== 200) {
      const req = await loadJson<{
        plan: { charges: Array<{ billable_metric_id: string }> };
      }>("06-plans-create.request.json");
      req.plan.charges[0]!.billable_metric_id =
        monthlyBm.body.billable_metric.lago_id;
      req.plan.charges[1]!.billable_metric_id =
        setupBm.body.billable_metric.lago_id;
      await api.post("/plans", req);
    }
    await api.post("/subscriptions", {
      subscription: {
        external_customer_id: "carga-express-mx",
        plan_code: "plan-carga-express-mx-combustible-79844679",
        external_id: "sub-carga-express-mx-combustible-current-usage",
        billing_time: "calendar",
      },
    });

    const res = await api.get<{
      customer_usage: {
        amount_cents: number;
        total_amount_cents: number;
        taxes_amount_cents: number;
        lago_invoice_id: null;
        charges_usage: Array<{
          units: string;
          events_count: number;
          amount_cents: number;
          billable_metric: { code: string };
        }>;
      };
    }>(
      "/customers/carga-express-mx/current_usage?external_subscription_id=sub-carga-express-mx-combustible-current-usage&apply_taxes=false",
    );
    expect(res.status).toBe(200);
    expect(res.body.customer_usage.amount_cents).toBe(0);
    expect(res.body.customer_usage.taxes_amount_cents).toBe(0);
    expect(res.body.customer_usage.lago_invoice_id).toBeNull();
    expect(res.body.customer_usage.charges_usage).toHaveLength(2);
    for (const c of res.body.customer_usage.charges_usage) {
      expect(c.units).toBe("0.0");
      expect(c.events_count).toBe(0);
      expect(c.amount_cents).toBe(0);
    }
  });

  it("PUT /customers/:external_id returns Lago's 404 resource_not_found", async () => {
    const res = await api.put<{ status: number; code: string }>(
      "/customers/carga-express-mx",
      { customer: { name: "ignored" } },
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("resource_not_found");
  });
});
