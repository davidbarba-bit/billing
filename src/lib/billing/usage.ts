import { and, eq, sql, gte, lte, isNull, or, lt, gt } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  events,
  subscriptionUnits,
  type BillableMetric,
  type Subscription,
} from "../../db/schema/index.js";
import { startOfMonthIn, startOfNextMonthIn } from "./tz-periods.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Round half-to-even (banker's rounding). Lago uses BigDecimal HALF_EVEN; the
 * IEEE-754 floats we get from `units * amount` are precise enough for the
 * cents-scale rounding we do here.
 */
/**
 * Lago serializes units with at least one decimal: integers become "2.0",
 * fractions get full precision ("0.5483870967741935"). Matches the captured
 * `current_usage` fixture shape.
 */
export function formatUnits(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : value.toString();
}

export function bankersRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exact half → round to even.
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Total days in the calendar month containing `periodEnd`, in `tz`. Used as
 * the prorate denominator for `calendar` interval billing (matches Lago: a
 * unit alive Mar 15 → Mar 31 prorates as 17/31, regardless of whether the
 * subscription itself started on Mar 1 or Mar 8).
 */
export function calendarMonthDays(periodEnd: Date, tz: string): number {
  const start = startOfMonthIn(periodEnd, tz);
  const next = startOfNextMonthIn(periodEnd, tz);
  return Math.round((next.getTime() - start.getTime()) / MS_PER_DAY);
}

/**
 * Computes the prorated unit fraction for a single subscription_unit row over
 * the [periodStart, periodEnd] window. Returns 0 if there's no overlap.
 *
 * The prorate denominator is the full calendar month containing the period
 * end (not the active sub window). This matches Lago's documented behavior.
 */
export function proratedUnitFraction(
  row: { addedAt: Date; removedAt: Date | null },
  periodStart: Date,
  periodEnd: Date,
  tz: string,
): number {
  const periodEndExclusive = new Date(periodEnd.getTime() + 1000);
  const aliveStart = Math.max(periodStart.getTime(), row.addedAt.getTime());
  const aliveEnd = Math.min(
    periodEndExclusive.getTime(),
    row.removedAt?.getTime() ?? periodEndExclusive.getTime(),
  );
  if (aliveEnd <= aliveStart) return 0;
  const aliveMs = aliveEnd - aliveStart;
  const denominatorDays = calendarMonthDays(periodEnd, tz);
  return aliveMs / MS_PER_DAY / denominatorDays;
}

/**
 * Counts the distinct units that had any overlap with [periodStart, periodEnd]
 * in the subscription_units table (for unique_count_agg recurring BMs).
 */
export async function countAliveUnitsInPeriod(
  db: DB,
  subscriptionId: string,
  bmCode: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  const rows = await db
    .select({ unitKey: subscriptionUnits.unitKey })
    .from(subscriptionUnits)
    .where(
      and(
        eq(subscriptionUnits.subscriptionId, subscriptionId),
        eq(subscriptionUnits.billableMetricCode, bmCode),
        // any overlap: added_at <= period_end AND (removed_at IS NULL OR removed_at >= period_start)
        lte(subscriptionUnits.addedAt, periodEnd),
        or(
          isNull(subscriptionUnits.removedAt),
          gte(subscriptionUnits.removedAt, periodStart),
        ),
      ),
    );
  return new Set(rows.map((r) => r.unitKey)).size;
}

/**
 * Loads the subscription_units rows that had any overlap with the period
 * (so we can prorate each one's alive fraction).
 */
export async function loadAliveUnitsInPeriod(
  db: DB,
  subscriptionId: string,
  bmCode: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<{ unitKey: string; addedAt: Date; removedAt: Date | null }[]> {
  const rows = await db
    .select({
      unitKey: subscriptionUnits.unitKey,
      addedAt: subscriptionUnits.addedAt,
      removedAt: subscriptionUnits.removedAt,
    })
    .from(subscriptionUnits)
    .where(
      and(
        eq(subscriptionUnits.subscriptionId, subscriptionId),
        eq(subscriptionUnits.billableMetricCode, bmCode),
        lte(subscriptionUnits.addedAt, periodEnd),
        or(
          isNull(subscriptionUnits.removedAt),
          gte(subscriptionUnits.removedAt, periodStart),
        ),
      ),
    );
  return rows;
}

/**
 * Counts distinct values of `field_name` seen in `events.properties` over the
 * period, for a non-recurring `unique_count_agg` BM (Numaris's "setup" pattern).
 */
export async function countDistinctEventFieldInPeriod(
  db: DB,
  orgId: string,
  externalSubscriptionId: string,
  bmCode: string,
  fieldName: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  const rows = await db
    .select({ properties: events.properties })
    .from(events)
    .where(
      and(
        eq(events.organizationId, orgId),
        eq(events.externalSubscriptionId, externalSubscriptionId),
        eq(events.code, bmCode),
        gte(events.timestamp, periodStart),
        lte(events.timestamp, periodEnd),
      ),
    );
  const seen = new Set<string>();
  for (const r of rows) {
    const v = (r.properties as Record<string, unknown>)[fieldName];
    if (typeof v === "string" && v.length > 0) seen.add(v);
  }
  return seen.size;
}

export async function countEventsInPeriod(
  db: DB,
  orgId: string,
  externalSubscriptionId: string,
  bmCode: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(events)
    .where(
      and(
        eq(events.organizationId, orgId),
        eq(events.externalSubscriptionId, externalSubscriptionId),
        eq(events.code, bmCode),
        gte(events.timestamp, periodStart),
        lte(events.timestamp, periodEnd),
      ),
    );
  return rows[0]?.count ?? 0;
}

export type ChargeUsage = {
  units: string;
  events_count: number;
  amount_cents: number;
};

/**
 * Computes the per-charge usage for the given charge configuration. Supports
 * the three flows Numaris uses:
 *
 * 1. unique_count_agg + recurring + prorated → sum of per-unit fractions
 * 2. unique_count_agg + recurring + NOT prorated → count of overlapping units
 * 3. unique_count_agg + NOT recurring → distinct field values in events
 */
export async function computeChargeUsage(
  db: DB,
  args: {
    orgId: string;
    subscription: Subscription;
    bm: BillableMetric;
    charge: { prorated: boolean; properties: Record<string, unknown> };
    tz: string;
  },
): Promise<ChargeUsage> {
  const { orgId, subscription, bm, charge, tz } = args;
  const periodStart = subscription.currentPeriodStart;
  const periodEnd = subscription.currentPeriodEnd;
  const amountPerUnit = Number(
    charge.properties["amount"] ?? 0,
  );

  let units = 0;

  if (bm.aggregationType === "unique_count_agg" && bm.recurring) {
    if (charge.prorated) {
      const rows = await loadAliveUnitsInPeriod(
        db,
        subscription.id,
        bm.code,
        periodStart,
        periodEnd,
      );
      let total = 0;
      for (const r of rows) {
        total += proratedUnitFraction(r, periodStart, periodEnd, tz);
      }
      units = total;
    } else {
      units = await countAliveUnitsInPeriod(
        db,
        subscription.id,
        bm.code,
        periodStart,
        periodEnd,
      );
    }
  } else if (bm.aggregationType === "unique_count_agg" && !bm.recurring) {
    units = await countDistinctEventFieldInPeriod(
      db,
      orgId,
      subscription.externalId,
      bm.code,
      bm.fieldName ?? "unit_external_id",
      periodStart,
      periodEnd,
    );
  }
  // Other aggregations: unused in phase 2; units stays 0.

  const unitsStr = formatUnits(units);

  const eventsCount = await countEventsInPeriod(
    db,
    orgId,
    subscription.externalId,
    bm.code,
    periodStart,
    periodEnd,
  );
  const amountCents = bankersRound(units * amountPerUnit * 100);

  return { units: unitsStr, events_count: eventsCount, amount_cents: amountCents };
}

// silence drizzle unused imports
void lt;
void gt;
