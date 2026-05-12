import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestHarness } from "../helpers/server.js";
import { TestClient } from "../helpers/http.js";

type AddOn = {
  lago_id: string;
  name: string;
  invoice_display_name: string | null;
  code: string;
  amount_cents: number;
  amount_currency: string;
  description: string | null;
  taxes: unknown[];
};

type AddOnBody = { add_on: AddOn };
type AddOnListBody = {
  add_ons: AddOn[];
  meta: { current_page: number; total_count: number };
};

describe("add_ons", () => {
  let harness: TestHarness;
  let api: TestClient;

  beforeAll(async () => {
    harness = await startTestServer();
    api = new TestClient(harness.baseUrl, harness.apiKey);
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("creates an add-on with the canonical shape", async () => {
    const res = await api.post<AddOnBody>("/add_ons", {
      add_on: {
        name: "Cobro mensual",
        code: "cobro-mensual",
        description: "Una descripcion",
        amount_cents: 45000,
        amount_currency: "MXN",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.add_on.code).toBe("cobro-mensual");
    expect(res.body.add_on.amount_cents).toBe(45000);
    expect(res.body.add_on.amount_currency).toBe("MXN");
    expect(res.body.add_on.invoice_display_name).toBeNull();
    expect(res.body.add_on.taxes).toEqual([]);
    expect(typeof res.body.add_on.lago_id).toBe("string");
  });

  it("rejects amount_cents <= 0 with 422", async () => {
    const res = await api.post<{ code: string }>("/add_ons", {
      add_on: {
        name: "Zero",
        code: "zero",
        amount_cents: 0,
        amount_currency: "MXN",
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
  });

  it("rejects negative amount_cents with 422", async () => {
    const res = await api.post<{ code: string }>("/add_ons", {
      add_on: {
        name: "Negative",
        code: "neg",
        amount_cents: -100,
        amount_currency: "MXN",
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
  });

  it("rejects invalid amount_currency with 422", async () => {
    const res = await api.post<{ code: string }>("/add_ons", {
      add_on: {
        name: "Bad ccy",
        code: "bad_ccy",
        amount_cents: 100,
        amount_currency: "mx",
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
  });

  it("returns 422 value_already_exist on duplicate code", async () => {
    await api.post("/add_ons", {
      add_on: {
        name: "First",
        code: "dup",
        amount_cents: 100,
        amount_currency: "MXN",
      },
    });
    const second = await api.post<{
      code: string;
      error_details: Record<string, string[]>;
    }>("/add_ons", {
      add_on: {
        name: "Second",
        code: "dup",
        amount_cents: 200,
        amount_currency: "MXN",
      },
    });
    expect(second.status).toBe(422);
    expect(second.body.error_details).toEqual({
      code: ["value_already_exist"],
    });
  });

  it("retrieves an add-on by code", async () => {
    await api.post("/add_ons", {
      add_on: {
        name: "Get me",
        code: "ao_get",
        amount_cents: 500,
        amount_currency: "USD",
      },
    });
    const res = await api.get<AddOnBody>("/add_ons/ao_get");
    expect(res.status).toBe(200);
    expect(res.body.add_on.code).toBe("ao_get");
  });

  it("returns 404 for unknown add-on", async () => {
    const res = await api.get<{ code: string }>("/add_ons/missing");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("add_on_not_found");
  });

  it("lists add-ons with pagination metadata", async () => {
    const res = await api.get<AddOnListBody>("/add_ons?page=1&per_page=10");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.add_ons)).toBe(true);
    expect(res.body.meta.current_page).toBe(1);
  });

  it("soft-deletes an add-on and hides it from subsequent reads", async () => {
    await api.post("/add_ons", {
      add_on: {
        name: "Del",
        code: "ao_del",
        amount_cents: 100,
        amount_currency: "MXN",
      },
    });
    const del = await api.delete<AddOnBody>("/add_ons/ao_del");
    expect(del.status).toBe(200);
    const after = await api.get<{ code: string }>("/add_ons/ao_del");
    expect(after.status).toBe(404);
  });

it("isolates add-ons across organizations", async () => {
    await api.post("/add_ons", {
      add_on: {
        name: "Tenant A",
        code: "ao_tenant_a",
        amount_cents: 100,
        amount_currency: "MXN",
      },
    });
    const other = await startTestServer();
    try {
      const otherClient = new TestClient(other.baseUrl, other.apiKey);
      const res = await otherClient.get<{ code: string }>(
        "/add_ons/ao_tenant_a",
      );
      expect(res.status).toBe(404);
    } finally {
      await other.close();
    }
  });
});
