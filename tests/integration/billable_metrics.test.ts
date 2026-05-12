import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestHarness } from "../helpers/server.js";
import { TestClient } from "../helpers/http.js";

type BM = {
  lago_id: string;
  name: string;
  code: string;
  aggregation_type: string;
  field_name: string | null;
  recurring: boolean;
  weighted_interval: string | null;
  active_subscriptions_count: number;
  draft_invoices_count: number;
  plans_count: number;
};

type BMBody = { billable_metric: BM };

describe("billable_metrics", () => {
  let harness: TestHarness;
  let api: TestClient;

  beforeAll(async () => {
    harness = await startTestServer();
    api = new TestClient(harness.baseUrl, harness.apiKey);
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("creates a unique_count_agg + recurring billable metric (Numaris main case)", async () => {
    const res = await api.post<BMBody>("/billable_metrics", {
      billable_metric: {
        name: "Unidades activas — Combustible",
        code: "bm-carga-express-mx-combustible-7be0a53d",
        aggregation_type: "unique_count_agg",
        field_name: "unit_external_id",
        recurring: true,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.billable_metric.recurring).toBe(true);
    expect(res.body.billable_metric.aggregation_type).toBe("unique_count_agg");
    expect(res.body.billable_metric.field_name).toBe("unit_external_id");
    expect(res.body.billable_metric.plans_count).toBe(0);
  });

  it("creates a unique_count_agg + non-recurring (Numaris setup case)", async () => {
    const res = await api.post<BMBody>("/billable_metrics", {
      billable_metric: {
        name: "Instalaciones nuevas — Combustible",
        code: "bm-setup-carga-express-mx-combustible-0c46b355",
        aggregation_type: "unique_count_agg",
        field_name: "unit_external_id",
        recurring: false,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.billable_metric.recurring).toBe(false);
  });

  it("accepts count_agg without field_name", async () => {
    const res = await api.post<BMBody>("/billable_metrics", {
      billable_metric: {
        name: "Count",
        code: "bm_count",
        aggregation_type: "count_agg",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.billable_metric.field_name).toBeNull();
  });

  it("rejects recurring:true on count_agg with 422", async () => {
    const res = await api.post<{
      code: string;
      error_details: Record<string, string[]>;
    }>("/billable_metrics", {
      billable_metric: {
        name: "Bad",
        code: "bm_bad_recurring",
        aggregation_type: "count_agg",
        recurring: true,
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
    expect(res.body.error_details["recurring"]).toBeDefined();
  });

  it("rejects recurring:true on max_agg with 422", async () => {
    const res = await api.post<{ code: string }>("/billable_metrics", {
      billable_metric: {
        name: "Bad",
        code: "bm_bad_max",
        aggregation_type: "max_agg",
        field_name: "x",
        recurring: true,
      },
    });
    expect(res.status).toBe(422);
  });

  it("requires field_name for sum_agg", async () => {
    const res = await api.post<{
      code: string;
      error_details: Record<string, string[]>;
    }>("/billable_metrics", {
      billable_metric: {
        name: "Bad",
        code: "bm_sum_no_field",
        aggregation_type: "sum_agg",
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.error_details["field_name"]).toBeDefined();
  });

  it("rejects unknown aggregation_type", async () => {
    const res = await api.post<{ code: string }>("/billable_metrics", {
      billable_metric: {
        name: "Bad",
        code: "bm_bad_agg",
        aggregation_type: "nonsense",
      },
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 value_already_exist on duplicate code", async () => {
    await api.post("/billable_metrics", {
      billable_metric: {
        name: "A",
        code: "bm_dup",
        aggregation_type: "count_agg",
      },
    });
    const second = await api.post<{
      error_details: Record<string, string[]>;
    }>("/billable_metrics", {
      billable_metric: {
        name: "B",
        code: "bm_dup",
        aggregation_type: "count_agg",
      },
    });
    expect(second.status).toBe(422);
    expect(second.body.error_details).toEqual({
      code: ["value_already_exist"],
    });
  });

  it("accepts and persists weighted_interval (D7)", async () => {
    const res = await api.post<BMBody>("/billable_metrics", {
      billable_metric: {
        name: "Weighted",
        code: "bm_weighted",
        aggregation_type: "sum_agg",
        field_name: "amount",
        weighted_interval: "seconds",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.billable_metric.weighted_interval).toBe("seconds");
  });

  it("retrieves a billable metric by code", async () => {
    await api.post("/billable_metrics", {
      billable_metric: {
        name: "Get",
        code: "bm_get",
        aggregation_type: "count_agg",
      },
    });
    const res = await api.get<BMBody>("/billable_metrics/bm_get");
    expect(res.status).toBe(200);
    expect(res.body.billable_metric.code).toBe("bm_get");
  });

  it("returns 404 for unknown billable metric", async () => {
    const res = await api.get<{ code: string }>("/billable_metrics/missing");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("billable_metric_not_found");
  });

  it("soft-deletes a billable metric", async () => {
    await api.post("/billable_metrics", {
      billable_metric: {
        name: "Del",
        code: "bm_del",
        aggregation_type: "count_agg",
      },
    });
    const del = await api.delete<BMBody>("/billable_metrics/bm_del");
    expect(del.status).toBe(200);
    const after = await api.get<{ code: string }>("/billable_metrics/bm_del");
    expect(after.status).toBe(404);
  });
});
