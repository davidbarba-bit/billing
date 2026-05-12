import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestHarness } from "../helpers/server.js";
import { TestClient } from "../helpers/http.js";
import { loadLagoSdk } from "../helpers/lago-sdk.js";

type CustomerBody = {
  customer: {
    lago_id: string;
    external_id: string;
    name: string | null;
    email: string | null;
    currency: string | null;
  };
};

type CustomerListBody = {
  customers: Array<CustomerBody["customer"]>;
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

  it("creates a customer with currency/timezone and returns lago_id", async () => {
    const res = await api.post<CustomerBody>("/customers", {
      customer: {
        external_id: "cust_001",
        name: "Acme Corp",
        email: "hi@acme.test",
        currency: "USD",
        timezone: "America/Mexico_City",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.customer.external_id).toBe("cust_001");
    expect(res.body.customer.name).toBe("Acme Corp");
    expect(res.body.customer.email).toBe("hi@acme.test");
    expect(res.body.customer.currency).toBe("USD");
    expect(typeof res.body.customer.lago_id).toBe("string");
  });

  it("upserts (200) when external_id already exists", async () => {
    const first = await api.post<CustomerBody>("/customers", {
      customer: { external_id: "cust_upsert", name: "v1" },
    });
    expect(first.status).toBe(201);

    const second = await api.post<CustomerBody>("/customers", {
      customer: { external_id: "cust_upsert", name: "v2" },
    });
    expect(second.status).toBe(200);
    expect(second.body.customer.name).toBe("v2");
    expect(second.body.customer.lago_id).toBe(first.body.customer.lago_id);
  });

  it("rejects 422 with validation_error when external_id is missing", async () => {
    const res = await api.post<{ code: string; error_details: unknown }>(
      "/customers",
      { customer: { name: "no id" } },
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_error");
    expect(res.body.error_details).toBeDefined();
  });

  it("validates currency is a 3-letter ISO code", async () => {
    const res = await api.post<{ code: string }>("/customers", {
      customer: { external_id: "cust_bad_ccy", currency: "us" },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_error");
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
    // Create a customer in our org
    await api.post("/customers", {
      customer: { external_id: "cust_tenant_a" },
    });

    // Spin a second harness (separate org) and confirm it cannot see it.
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
        findCustomer?: (id: string) => Promise<unknown>;
      };
    };
    const result = (await client.customers.createCustomer({
      customer: {
        external_id: "cust_sdk",
        name: "SDK Customer",
        currency: "EUR",
      },
    })) as { data?: { customer?: { external_id?: string } } };

    // Recent SDK versions return { data, response } shaped objects.
    const customer = result?.data?.customer ?? (result as { customer?: { external_id?: string } }).customer;
    expect(customer?.external_id).toBe("cust_sdk");
  });
});
