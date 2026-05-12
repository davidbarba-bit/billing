import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestServer, type TestHarness } from "../helpers/server.js";
import { TestClient } from "../helpers/http.js";
import { loadLagoSdk } from "../helpers/lago-sdk.js";
import { customerTaxes } from "../../src/db/schema/index.js";

type Tax = {
  lago_id: string;
  name: string;
  code: string;
  rate: number;
  applied_to_organization: boolean;
  add_ons_count: number;
  customers_count: number;
  plans_count: number;
  charges_count: number;
  commitments_count: number;
};

type TaxBody = { tax: Tax };
type TaxListBody = {
  taxes: Tax[];
  meta: { current_page: number; total_count: number };
};

describe("taxes", () => {
  let harness: TestHarness;
  let api: TestClient;

  beforeAll(async () => {
    harness = await startTestServer();
    api = new TestClient(harness.baseUrl, harness.apiKey);
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("creates a tax with counters and Lago-canonical shape", async () => {
    const res = await api.post<TaxBody>("/taxes", {
      tax: {
        name: "IVA",
        code: "iva_mx",
        rate: 16,
        description: "IVA Mexico",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.tax.code).toBe("iva_mx");
    expect(res.body.tax.rate).toBe(16);
    expect(res.body.tax.applied_to_organization).toBe(false);
    expect(res.body.tax.customers_count).toBe(0);
    expect(res.body.tax.add_ons_count).toBe(0);
    expect(res.body.tax.plans_count).toBe(0);
    expect(res.body.tax.charges_count).toBe(0);
    expect(res.body.tax.commitments_count).toBe(0);
  });

  it("accepts rate as a string (Numaris/SDK behavior)", async () => {
    const res = await api.post<TaxBody>("/taxes", {
      tax: { name: "IVA Str", code: "iva_str", rate: "16" },
    });
    expect(res.status).toBe(200);
    expect(res.body.tax.rate).toBe(16);
  });

  it("returns 422 value_already_exist on duplicate code (strict Lago)", async () => {
    await api.post("/taxes", {
      tax: { name: "VAT", code: "vat_test", rate: 19 },
    });
    const second = await api.post<{
      code: string;
      error_details: Record<string, string[]>;
    }>("/taxes", { tax: { name: "VAT EU", code: "vat_test", rate: 21 } });
    expect(second.status).toBe(422);
    expect(second.body.code).toBe("validation_errors");
    expect(second.body.error_details).toEqual({
      code: ["value_already_exist"],
    });
  });

  it("rejects invalid rate (>100)", async () => {
    const res = await api.post<{ code: string }>("/taxes", {
      tax: { name: "Bad", code: "bad_rate", rate: 250 },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
  });

  it("rejects missing required fields", async () => {
    const res = await api.post<{ code: string }>("/taxes", {
      tax: { name: "Missing code", rate: 10 },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
  });

  it("retrieves a tax by code", async () => {
    await api.post("/taxes", {
      tax: { name: "Get", code: "tax_get", rate: 8 },
    });
    const res = await api.get<TaxBody>("/taxes/tax_get");
    expect(res.status).toBe(200);
    expect(res.body.tax.code).toBe("tax_get");
  });

  it("returns 404 for unknown tax", async () => {
    const res = await api.get<{ code: string }>("/taxes/missing");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("tax_not_found");
  });

  it("lists taxes with pagination metadata", async () => {
    const res = await api.get<TaxListBody>("/taxes?page=1&per_page=10");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.taxes)).toBe(true);
    expect(res.body.meta.current_page).toBe(1);
  });

  it("deletes a tax", async () => {
    await api.post("/taxes", {
      tax: { name: "Del", code: "tax_del", rate: 5 },
    });
    const del = await api.delete<TaxBody>("/taxes/tax_del");
    expect(del.status).toBe(200);
    const after = await api.get<{ code: string }>("/taxes/tax_del");
    expect(after.status).toBe(404);
  });

  it("auto-applies an org-wide tax to existing customers + reflects counters", async () => {
    const custRes = await api.post<{ customer: { lago_id: string } }>(
      "/customers",
      { customer: { external_id: "cust_for_tax", currency: "MXN" } },
    );
    const customerId = custRes.body.customer.lago_id;

    const taxRes = await api.post<TaxBody>("/taxes", {
      tax: {
        name: "Org IVA",
        code: "iva_org",
        rate: 16,
        applied_to_organization: true,
      },
    });
    expect(taxRes.status).toBe(200);
    const taxId = taxRes.body.tax.lago_id;
    expect(taxRes.body.tax.customers_count).toBeGreaterThanOrEqual(1);

    const links = await harness.db
      .select()
      .from(customerTaxes)
      .where(eq(customerTaxes.customerId, customerId));
    expect(links.some((l) => l.taxId === taxId)).toBe(true);
  });

  it("auto-applies an org-wide tax to NEW customers", async () => {
    await api.post("/taxes", {
      tax: {
        name: "New Cust Tax",
        code: "new_cust_tax",
        rate: 10,
        applied_to_organization: true,
      },
    });

    const cust = await api.post<{ customer: { lago_id: string } }>(
      "/customers",
      { customer: { external_id: "cust_after_tax" } },
    );
    const links = await harness.db
      .select()
      .from(customerTaxes)
      .where(eq(customerTaxes.customerId, cust.body.customer.lago_id));
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  it("isolates taxes across organizations", async () => {
    await api.post("/taxes", {
      tax: { name: "Tenant A", code: "tax_tenant_a", rate: 7 },
    });
    const other = await startTestServer();
    try {
      const otherClient = new TestClient(other.baseUrl, other.apiKey);
      const res = await otherClient.get<{ code: string }>(
        "/taxes/tax_tenant_a",
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
        `[taxes.test] skipping SDK interop: ${sdk.errorReason ?? "unavailable"}`,
      );
      return;
    }

    const client = sdk.client as {
      taxes: { createTax: (body: unknown) => Promise<unknown> };
    };
    const result = (await client.taxes.createTax({
      tax: { name: "SDK Tax", code: "sdk_tax", rate: 12 },
    })) as { data?: { tax?: Tax } };
    const tax = result?.data?.tax ?? (result as { tax?: Tax }).tax;
    expect(tax?.code).toBe("sdk_tax");
    expect(tax?.customers_count).toBe(0);
  });
});
