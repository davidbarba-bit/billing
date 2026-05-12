import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { startTestServer, type TestHarness } from "../helpers/server.js";
import { TestClient } from "../helpers/http.js";
import { subscriptionUnits, subscriptions } from "../../src/db/schema/index.js";

type Event = {
  lago_id: string;
  transaction_id: string;
  lago_customer_id: null;
  code: string;
  timestamp: string;
  precise_total_amount_cents: number | null;
  properties: Record<string, unknown>;
  lago_subscription_id: null;
  external_subscription_id: string;
};

type EventBody = { event: Event };

async function setupForEvents(api: TestClient): Promise<void> {
  await api.post("/customers", {
    customer: { external_id: "cust-evt", currency: "MXN", timezone: "UTC" },
  });
  await api.post("/billable_metrics", {
    billable_metric: {
      name: "Units",
      code: "bm-units",
      aggregation_type: "unique_count_agg",
      field_name: "unit_external_id",
      recurring: true,
    },
  });
  await api.post("/billable_metrics", {
    billable_metric: {
      name: "Setup",
      code: "bm-setup",
      aggregation_type: "unique_count_agg",
      field_name: "unit_external_id",
      recurring: false,
    },
  });
  const bm = await api.get<{ billable_metric: { lago_id: string } }>(
    "/billable_metrics/bm-units",
  );
  const setupBm = await api.get<{ billable_metric: { lago_id: string } }>(
    "/billable_metrics/bm-setup",
  );
  await api.post("/plans", {
    plan: {
      name: "Plan",
      code: "plan-evt",
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
        {
          billable_metric_id: setupBm.body.billable_metric.lago_id,
          charge_model: "standard",
          prorated: false,
          properties: { amount: "1200.00" },
        },
      ],
    },
  });
  await api.post("/subscriptions", {
    subscription: {
      external_customer_id: "cust-evt",
      plan_code: "plan-evt",
      external_id: "sub-evt",
      billing_time: "calendar",
    },
  });
}

describe("events", () => {
  let harness: TestHarness;
  let api: TestClient;

  beforeAll(async () => {
    harness = await startTestServer();
    api = new TestClient(harness.baseUrl, harness.apiKey);
    await setupForEvents(api);
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("accepts an add event and returns timestamp as ISO", async () => {
    const epochSecs = 1747080000; // 2025-05-12T20:00:00Z
    const res = await api.post<EventBody>("/events", {
      event: {
        transaction_id: "evt-add-1",
        external_subscription_id: "sub-evt",
        code: "bm-units",
        timestamp: epochSecs,
        properties: {
          unit_external_id: "u-1",
          operation_type: "add",
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.event.timestamp).toBe("2025-05-12T20:00:00.000Z");
    expect(res.body.event.lago_customer_id).toBeNull();
    expect(res.body.event.lago_subscription_id).toBeNull();
    expect(res.body.event.precise_total_amount_cents).toBeNull();
    expect(typeof res.body.event.lago_id).toBe("string");
  });

  it("rejects ISO-string timestamps with 422 (Lago Cloud silently mis-parses these — mini-Lago refuses)", async () => {
    const res = await api.post<{ code: string }>("/events", {
      event: {
        transaction_id: "evt-bad-ts",
        external_subscription_id: "sub-evt",
        code: "bm-units",
        timestamp: "2026-05-12T20:00:00Z" as unknown as number,
        properties: { unit_external_id: "u-1", operation_type: "add" },
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_errors");
  });

  it("returns 422 value_already_exist on duplicate transaction_id (always, body-agnostic)", async () => {
    await api.post("/events", {
      event: {
        transaction_id: "evt-dup",
        external_subscription_id: "sub-evt",
        code: "bm-units",
        timestamp: 1747080000,
        properties: { unit_external_id: "u-1", operation_type: "add" },
      },
    });
    const second = await api.post<{ error_details: Record<string, string[]> }>(
      "/events",
      {
        event: {
          transaction_id: "evt-dup",
          external_subscription_id: "sub-evt",
          code: "bm-units",
          timestamp: 1747080000,
          properties: { unit_external_id: "u-1", operation_type: "add" },
        },
      },
    );
    expect(second.status).toBe(422);
    expect(second.body.error_details).toEqual({
      transaction_id: ["value_already_exist"],
    });
  });

  it("rejects events whose billable_metric code is unknown", async () => {
    const res = await api.post<{ error_details: Record<string, string[]> }>(
      "/events",
      {
        event: {
          transaction_id: "evt-bad-code",
          external_subscription_id: "sub-evt",
          code: "no-such-bm",
          timestamp: 1747080000,
          properties: {},
        },
      },
    );
    expect(res.status).toBe(422);
    expect(res.body.error_details).toEqual({ code: ["value_is_invalid"] });
  });

  it("creates a subscription_units row for add on unique_count_agg+recurring", async () => {
    await api.post("/events", {
      event: {
        transaction_id: "evt-lifecycle-add-1",
        external_subscription_id: "sub-evt",
        code: "bm-units",
        timestamp: 1747080000,
        properties: {
          unit_external_id: "u-lifecycle-1",
          operation_type: "add",
        },
      },
    });

    const [sub] = await harness.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.externalId, "sub-evt"));
    expect(sub).toBeDefined();

    const rows = await harness.db
      .select()
      .from(subscriptionUnits)
      .where(
        and(
          eq(subscriptionUnits.subscriptionId, sub!.id),
          eq(subscriptionUnits.unitKey, "u-lifecycle-1"),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.removedAt).toBeNull();
  });

  it("no-op when add is repeated on an already-alive unit", async () => {
    // First add
    await api.post("/events", {
      event: {
        transaction_id: "evt-noop-add-1",
        external_subscription_id: "sub-evt",
        code: "bm-units",
        timestamp: 1747080000,
        properties: { unit_external_id: "u-noop", operation_type: "add" },
      },
    });
    // Second add (Numaris monthly ping, same unit, next month)
    await api.post("/events", {
      event: {
        transaction_id: "evt-noop-add-2",
        external_subscription_id: "sub-evt",
        code: "bm-units",
        timestamp: 1749758400,
        properties: { unit_external_id: "u-noop", operation_type: "add" },
      },
    });

    const [sub] = await harness.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.externalId, "sub-evt"));
    const rows = await harness.db
      .select()
      .from(subscriptionUnits)
      .where(
        and(
          eq(subscriptionUnits.subscriptionId, sub!.id),
          eq(subscriptionUnits.unitKey, "u-noop"),
        ),
      );
    // Still ONE row — the second add was a no-op.
    expect(rows.length).toBe(1);
  });

  it("sets removed_at on the alive row when remove arrives", async () => {
    await api.post("/events", {
      event: {
        transaction_id: "evt-remove-add",
        external_subscription_id: "sub-evt",
        code: "bm-units",
        timestamp: 1747080000,
        properties: { unit_external_id: "u-remove", operation_type: "add" },
      },
    });
    await api.post("/events", {
      event: {
        transaction_id: "evt-remove-do",
        external_subscription_id: "sub-evt",
        code: "bm-units",
        timestamp: 1747166400,
        properties: { unit_external_id: "u-remove", operation_type: "remove" },
      },
    });

    const [sub] = await harness.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.externalId, "sub-evt"));
    const rows = await harness.db
      .select()
      .from(subscriptionUnits)
      .where(
        and(
          eq(subscriptionUnits.subscriptionId, sub!.id),
          eq(subscriptionUnits.unitKey, "u-remove"),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.removedAt).not.toBeNull();
    expect(rows[0]!.removedAt!.toISOString()).toBe("2025-05-13T20:00:00.000Z");
  });

  it("no lifecycle row for non-recurring unique_count_agg (setup BM)", async () => {
    await api.post("/events", {
      event: {
        transaction_id: "evt-setup-1",
        external_subscription_id: "sub-evt",
        code: "bm-setup",
        timestamp: 1747080000,
        properties: { unit_external_id: "u-setup", operation_type: "add" },
      },
    });

    const [sub] = await harness.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.externalId, "sub-evt"));
    const rows = await harness.db
      .select()
      .from(subscriptionUnits)
      .where(
        and(
          eq(subscriptionUnits.subscriptionId, sub!.id),
          eq(subscriptionUnits.billableMetricCode, "bm-setup"),
        ),
      );
    // Non-recurring → no lifecycle.
    expect(rows.length).toBe(0);
  });

  it("isolates events across organizations", async () => {
    await api.post("/events", {
      event: {
        transaction_id: "evt-iso",
        external_subscription_id: "sub-evt",
        code: "bm-units",
        timestamp: 1747080000,
        properties: { unit_external_id: "u-iso", operation_type: "add" },
      },
    });

    const other = await startTestServer();
    try {
      const otherClient = new TestClient(other.baseUrl, other.apiKey);
      // Same transaction_id in a different org should succeed (per-org unique).
      const res = await otherClient.post("/events", {
        event: {
          transaction_id: "evt-iso",
          external_subscription_id: "sub-evt",
          code: "bm-units",
          timestamp: 1747080000,
          properties: {},
        },
      });
      // Different org doesn't have BM, so we expect 422 for "code not found",
      // NOT 422 for "transaction_id duplicate". Asserts cross-org isolation.
      expect(res.status).toBe(422);
      const body = res.body as { error_details: Record<string, string[]> };
      expect(body.error_details["code"]).toBeDefined();
      expect(body.error_details["transaction_id"]).toBeUndefined();
    } finally {
      await other.close();
    }
  });
});
