import { and, eq, isNull, desc } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  billableMetrics,
  subscriptionUnits,
  type BillableMetric,
  type Subscription,
} from "../../db/schema/index.js";

type EventForLifecycle = {
  timestamp: Date;
  properties: Record<string, unknown>;
};

/**
 * Applies a single event to the `subscription_units` lifecycle table.
 *
 * Mini-Lago tracks alive units (rows with `removed_at IS NULL`) per
 * (subscription, billable_metric_code, unit_key) for any
 * `unique_count_agg + recurring` BM:
 *
 * - `operation_type:"add"` on a not-alive unit → INSERT a new row.
 * - `operation_type:"add"` on an already-alive unit → no-op (the existing
 *   added_at wins; subsequent monthly pings shouldn't refresh the anchor).
 * - `operation_type:"remove"` on an alive unit → UPDATE its `removed_at`.
 * - `operation_type:"remove"` on a not-alive unit → no-op (matches Lago).
 *
 * Returns true iff the lifecycle was meaningfully advanced (insert or update).
 */
export async function applyEventToLifecycle(
  tx: DB,
  bm: BillableMetric,
  subscription: Subscription,
  event: EventForLifecycle,
): Promise<boolean> {
  if (bm.aggregationType !== "unique_count_agg" || !bm.recurring) {
    return false;
  }
  const fieldName = bm.fieldName ?? "unit_external_id";
  const unitKey = event.properties[fieldName];
  if (typeof unitKey !== "string" || unitKey.length === 0) {
    // Recurring agg needs a unit key; without one the lifecycle can't advance.
    return false;
  }
  const operation =
    typeof event.properties["operation_type"] === "string"
      ? (event.properties["operation_type"] as string)
      : "add";

  // Latest alive row for this unit (if any). We don't lock the customer or
  // subscription here — the caller has already opened a transaction and locked
  // the subscription row via SELECT FOR UPDATE.
  const [latestAlive] = await tx
    .select()
    .from(subscriptionUnits)
    .where(
      and(
        eq(subscriptionUnits.subscriptionId, subscription.id),
        eq(subscriptionUnits.billableMetricCode, bm.code),
        eq(subscriptionUnits.unitKey, unitKey),
        isNull(subscriptionUnits.removedAt),
      ),
    )
    .orderBy(desc(subscriptionUnits.addedAt))
    .limit(1);

  if (operation === "remove") {
    if (!latestAlive) return false;
    await tx
      .update(subscriptionUnits)
      .set({ removedAt: event.timestamp })
      .where(eq(subscriptionUnits.id, latestAlive.id));
    return true;
  }

  // add (default)
  if (latestAlive) return false;
  await tx.insert(subscriptionUnits).values({
    organizationId: subscription.organizationId,
    subscriptionId: subscription.id,
    billableMetricCode: bm.code,
    unitKey,
    addedAt: event.timestamp,
  });
  return true;
}

export async function findBmByCode(
  tx: DB,
  orgId: string,
  code: string,
): Promise<BillableMetric | undefined> {
  const [row] = await tx
    .select()
    .from(billableMetrics)
    .where(
      and(
        eq(billableMetrics.organizationId, orgId),
        eq(billableMetrics.code, code),
        isNull(billableMetrics.deletedAt),
      ),
    )
    .limit(1);
  return row;
}
