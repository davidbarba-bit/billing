import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestHarness } from "../helpers/server.js";
import { TestClient } from "../helpers/http.js";
import { loadLagoSdk } from "../helpers/lago-sdk.js";

type EmbeddedTax = {
  lago_id: string;
  code: string;
  rate: number;
  customers_count: number;
};

type Customer = {
  lago_id: string;
  external_id: string;
  name: string | null;
  email: string | null;
  currency: string | null;
  tax_identification_number: string | null;
  country: string | null;
  sequential_id: number;
  slug: string;
  applicable_timezone: string;
  finalize_zero_amount_invoice: string;
  metadata: unknown[];
  taxes: EmbeddedTax[];
  integration_customers: unknown[];
  billing_configuration: Record<string, unknown>;
  shipping_address: Record<string, unknown>;
};

type CustomerBody = { customer: Customer };
type CustomerListBody = {
  customers: Customer[];
  meta: { current_page: number; total_pages: number; total_count: number };
};

describe("customers", () => {
  let harness: TestHarness;
  let api: TestClient;

  beforeAll(async () => {
    harness = await startTestServer();
    api = new TestClient(harness.baseUrl, harness.apiKey);
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("rejects requests without a bearer token", async () => {
    const res = await fetch(`${harness.baseUrl}/api/v1/customers`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: number; code: string };
    expect(body.status).toBe(401);
    expect(body.code).toBe("missing_bearer_token");
  });

  it("rejects requests with an invalid API key", async () => {
    const res = await fetch(`${harness.baseUrl}/api/v1/customers`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_api_key");
  });

  it("creates a customer with the full Lago-canonical shape", async () => {
    const res = await api.post<CustomerBody>("/customers", {
      customer: {
        external_id: "cust_001",
        name: "Acme Corp",
        email: "hi@acme.test",
        currency: "USD",
        country: "US",
        timezone: "America/Mexico_City",
        tax_identification_number: "ACME250101AAA",
      },
    });
    expect(res.status).toBe(200);
    const c = res.body.customer;
    expect(c.external_id).toBe("cust_001");
    expect(c.name).toBe("Acme Corp");
    expect(c.email).toBe("hi@acme.test");
    expect(c.currency).toBe("USD");
    expect(c.country).toBe("US");
    expect(c.tax_identification_number).toBe("ACME250101AAA");
    expect(c.applicable_timezone).toBe("America/Mexico_City");
    expect(c.finalize_zero_amount_invoice).toBe("inherit");
    expect(c.metadata).toEqual([]);
    expect(c.taxes).toEqual([]);
    expect(c.integration_customers).toEqual([]);
    expect(c.sequential_id).toBeGreaterThan(0);
    expect(c.slug).toMatch(/^[A-Z]{3}-[0-9A-F]{4}-\d{3,}$/u);
    expect(typeof c.lago_id).toBe("string");
  });

  it("falls back applicable_timezone to UTC when none set", async () => {
    const res = await api.post<CustomerBody>("/customers", {
      customer: { external_id: "cust_no_tz" },
    });
    expect(res.body.customer.applicable_timezone).toBe("UTC");
  });

  it("upserts on duplicate external_id and merges only sent fields", async () => {
    const first = await api.post<CustomerBody>("/customers", {
      customer: {
        external_id: "cust_dup",
        name: "v1",
        currency: "USD",
        country: "US",
        tax_identification_number: "RFC123",
      },
    });
    expect(first.status).toBe(200);
    const initialLagoId = first.body.customer.lago_id;

    // Re-POST with only email — everything else must persist.
    const second = await api.post<CustomerBody>("/customers", {
      customer: { external_id: "cust_dup", email: "new@example.test" },
    });
    expect(second.status).toBe(200);
    expect(second.body.customer.lago_id).toBe(initialLagoId);
    expect(second.body.customer.email).toBe("new@example.test");
    // Preserved:
    expect(second.body.customer.name).toBe("v1");
    expect(second.body.customer.currency).toBe("USD");
    expect(second.body.customer.country).toBe("US");
    expect(second.body.customer.tax_identification_number).toBe("RFC123");
  });

  it("upsert with explicit null clears the field (Lago behavior)", async () => {
    await api.post("/customers", {
      customer: {
        external_id: "cust_null_clear",
        email: "before@example.test",
      },
    });
    const after = await api.post<CustomerBody>("/customers", {
      customer: { external_id: "cust_null_clear", email: null },
    });
    expect(after.status).toBe(200);
    expect(after.body.customer.email).toBeNull();
  });

  it("upsert with new tax_codes REPLACES the explicit list", async () => {
    await api.post("/taxes", {
      tax: { name: "T1", code: "tc_a", rate: 10 },
    });
    await api.post("/taxes", {
      tax: { name: "T2", code: "tc_b", rate: 5 },
    });

    const first = await api.post<CustomerBody>("/customers", {
      customer: { external_id: "cust_taxes_replace", tax_codes: ["tc_a"] },
    });
    expect(first.body.customer.taxes.map((t) => t.code)).toEqual(["tc_a"]);

    const second = await api.post<CustomerBody>("/customers", {
      customer: { external_id: "cust_taxes_replace", tax_codes: ["tc_b"] },
    });
    expect(second.body.customer.taxes.map((t) => t.code)).toEqual(["tc_b"]);
  });

  it("PUT /customers/:external_id returns 404 resource_not_found", async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/v1/customers/whatever`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${harness.apiKey}`,
        },
        body: JSON.stringify({ customer: {} }),
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("resource_not_found");
  });

  it("links tax_codes provided at create time", async () => {
    await api.post("/taxes", {
      tax: { name: "IVA Linked", code: "iva_linked", rate: 16 },
    });
    const res = await api.post<CustomerBody>("/customers", {
      customer: {
        external_id: "cust_tax_codes",
        currency: "MXN",
        tax_codes: ["iva_linked"],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.customer.taxes.map((t) => t.code)).toContain("iva_linked");
  });

  it("rejects unknown tax_codes with 422 / validation_errors", async () => {
    const res = await api.post<{
      code: string;
      error_details: Record<string, string[]>;
    }>("/customers", {
      customer: { external_id: "cust_bad_tax", tax_codes: ["nope"] },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
    expect(res.body.error_details["tax_codes"]).toEqual(["value_is_invalid"]);
  });

  it("rejects 422 with validation_errors when external_id is missing", async () => {
    const res = await api.post<{ code: string; error_details: unknown }>(
      "/customers",
      { customer: { name: "no id" } },
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
    expect(res.body.error_details).toBeDefined();
  });

  it("validates currency is a 3-letter ISO code", async () => {
    const res = await api.post<{ code: string }>("/customers", {
      customer: { external_id: "cust_bad_ccy", currency: "us" },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
  });

  it("validates country is a 2-letter ISO code", async () => {
    const res = await api.post<{ code: string }>("/customers", {
      customer: { external_id: "cust_bad_country", country: "mexico" },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await fetch(`${harness.baseUrl}/api/v1/customers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${harness.apiKey}`,
      },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("malformed_json");
  });

  it("retrieves a customer by external_id", async () => {
    await api.post("/customers", {
      customer: { external_id: "cust_read", name: "Read Me" },
    });
    const res = await api.get<CustomerBody>("/customers/cust_read");
    expect(res.status).toBe(200);
    expect(res.body.customer.external_id).toBe("cust_read");
    expect(res.body.customer.slug).toMatch(/^[A-Z]{3}-[0-9A-F]{4}-\d{3,}$/u);
  });

  it("returns 404 for unknown customer", async () => {
    const res = await api.get<{ code: string }>("/customers/does_not_exist");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("customer_not_found");
  });

  it("lists customers with pagination metadata", async () => {
    for (let i = 0; i < 3; i++) {
      await api.post("/customers", {
        customer: { external_id: `cust_list_${i}` },
      });
    }
    const res = await api.get<CustomerListBody>("/customers?page=1&per_page=2");
    expect(res.status).toBe(200);
    expect(res.body.customers.length).toBe(2);
    expect(res.body.meta.current_page).toBe(1);
    expect(res.body.meta.total_count).toBeGreaterThanOrEqual(3);
    expect(res.body.meta.total_pages).toBeGreaterThanOrEqual(2);
  });

  it("soft-deletes a customer and hides it from subsequent reads", async () => {
    await api.post("/customers", {
      customer: { external_id: "cust_del" },
    });
    const del = await api.delete<CustomerBody>("/customers/cust_del");
    expect(del.status).toBe(200);

    const after = await api.get<{ code: string }>("/customers/cust_del");
    expect(after.status).toBe(404);
  });

  it("isolates customers across organizations", async () => {
    await api.post("/customers", {
      customer: { external_id: "cust_tenant_a" },
    });

    const other = await startTestServer();
    try {
      const otherClient = new TestClient(other.baseUrl, other.apiKey);
      const res = await otherClient.get<{ code: string }>(
        "/customers/cust_tenant_a",
      );
      expect(res.status).toBe(404);
    } finally {
      await other.close();
    }
  });

  it("interoperates with the official lago-javascript-client when available", async () => {
    const sdk = await loadLagoSdk(harness.baseUrl, harness.apiKey);
    if (!sdk.available || !sdk.client) {
      console.warn(
        `[customers.test] skipping SDK interop: ${sdk.errorReason ?? "unavailable"}`,
      );
      return;
    }

    const client = sdk.client as {
      customers: {
        createCustomer: (body: unknown) => Promise<unknown>;
      };
    };
    const result = (await client.customers.createCustomer({
      customer: {
        external_id: "cust_sdk",
        name: "SDK Customer",
        currency: "EUR",
        country: "FR",
      },
    })) as { data?: { customer?: Customer } };

    const customer =
      result?.data?.customer ?? (result as { customer?: Customer }).customer;
    expect(customer?.external_id).toBe("cust_sdk");
    expect(customer?.country).toBe("FR");
  });
});
