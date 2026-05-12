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

  it("PUT /customers/:external_id returns Lago's 404 resource_not_found", async () => {
    const res = await api.put<{ status: number; code: string }>(
      "/customers/carga-express-mx",
      { customer: { name: "ignored" } },
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("resource_not_found");
  });
});
