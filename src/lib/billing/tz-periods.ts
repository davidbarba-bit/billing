/**
 * Timezone-aware period boundary helpers. Mini-Lago aligns calendar months
 * and anniversary periods to the customer's `applicable_timezone` (D4); these
 * helpers convert between UTC instants and wall-clock components in a given
 * IANA zone using only the platform's `Intl` API — no external deps.
 */

type WallClock = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsToObject(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

/** Returns wall-clock components for `instant` in the given IANA zone. */
export function wallClockIn(instant: Date, tz: string): WallClock {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = partsToObject(fmt.formatToParts(instant));
  // Intl returns "24" for midnight in some browsers — normalise to 0.
  let hour = Number(parts["hour"] ?? "0");
  if (hour === 24) hour = 0;
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    hour,
    minute: Number(parts["minute"] ?? "0"),
    second: Number(parts["second"] ?? "0"),
  };
}

/** Offset (ms) of `tz` at `instant`. Positive when `tz` is east of UTC. */
function offsetMs(instant: Date, tz: string): number {
  const wc = wallClockIn(instant, tz);
  const asUtc = Date.UTC(
    wc.year,
    wc.month - 1,
    wc.day,
    wc.hour,
    wc.minute,
    wc.second,
  );
  return asUtc - instant.getTime();
}

/**
 * Inverse of `wallClockIn`: returns the UTC instant whose wall-clock in `tz`
 * matches `wc`. Iterates twice to cover DST transitions.
 */
export function instantFromWallClock(wc: WallClock, tz: string): Date {
  const naive = Date.UTC(
    wc.year,
    wc.month - 1,
    wc.day,
    wc.hour,
    wc.minute,
    wc.second,
  );
  const off1 = offsetMs(new Date(naive), tz);
  const corrected = new Date(naive - off1);
  const off2 = offsetMs(corrected, tz);
  return new Date(naive - off2);
}

/** First instant of the calendar month containing `instant`, in `tz`. */
export function startOfMonthIn(instant: Date, tz: string): Date {
  const wc = wallClockIn(instant, tz);
  return instantFromWallClock(
    { year: wc.year, month: wc.month, day: 1, hour: 0, minute: 0, second: 0 },
    tz,
  );
}

/** First instant of the next calendar month after `instant`, in `tz`. */
export function startOfNextMonthIn(instant: Date, tz: string): Date {
  const wc = wallClockIn(instant, tz);
  const nextMonth = wc.month === 12 ? 1 : wc.month + 1;
  const nextYear = wc.month === 12 ? wc.year + 1 : wc.year;
  return instantFromWallClock(
    { year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0, second: 0 },
    tz,
  );
}

/** Last second (23:59:59) of the calendar month containing `instant`, in `tz`. */
export function endOfMonthIn(instant: Date, tz: string): Date {
  // Easier than computing the last day of the month: `next_month_start - 1s`.
  return new Date(startOfNextMonthIn(instant, tz).getTime() - 1000);
}

/**
 * Anniversary period boundary: given an anchor instant `anchor` and a query
 * instant `at`, find the period [start, end] containing `at` where periods
 * tile contiguously every month starting from `anchor`.
 */
export function anniversaryPeriodIn(
  anchor: Date,
  at: Date,
  tz: string,
): { start: Date; end: Date } {
  const anchorWc = wallClockIn(anchor, tz);

  // Walk monthly from the anchor until the period contains `at`. This is
  // O(months_since_anchor) but for any reasonable subscription that's a
  // handful of iterations — keep it dumb but correct over DST and day-31
  // edges (last day of short months snaps to the month's actual last day).
  let monthOffset = 0;
  // Safety cap to avoid runaway loops on bad input.
  for (let i = 0; i < 1200; i++) {
    const start = monthlyAnchorIn(anchorWc, monthOffset, tz);
    const next = monthlyAnchorIn(anchorWc, monthOffset + 1, tz);
    if (at.getTime() < next.getTime()) {
      const end = new Date(next.getTime() - 1000);
      return { start, end };
    }
    monthOffset++;
  }
  throw new Error("anniversaryPeriodIn: failed to converge");
}

function monthlyAnchorIn(
  anchorWc: WallClock,
  monthOffset: number,
  tz: string,
): Date {
  const totalMonths = (anchorWc.year * 12 + (anchorWc.month - 1)) + monthOffset;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  // Day 31 in a 30-day month snaps to the month's last day, matching Lago.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(anchorWc.day, daysInMonth);
  return instantFromWallClock(
    {
      year,
      month,
      day,
      hour: anchorWc.hour,
      minute: anchorWc.minute,
      second: anchorWc.second,
    },
    tz,
  );
}
