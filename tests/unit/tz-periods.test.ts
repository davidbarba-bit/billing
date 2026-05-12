import { describe, expect, it } from "vitest";
import {
  startOfMonthIn,
  startOfNextMonthIn,
  endOfMonthIn,
  anniversaryPeriodIn,
  wallClockIn,
} from "../../src/lib/billing/tz-periods.js";

describe("tz-periods", () => {
  it("computes calendar month boundaries in America/Mexico_City", () => {
    const t = new Date("2026-05-08T17:33:56Z");
    const tz = "America/Mexico_City";

    const start = startOfMonthIn(t, tz);
    expect(start.toISOString()).toBe("2026-05-01T06:00:00.000Z");

    const next = startOfNextMonthIn(t, tz);
    expect(next.toISOString()).toBe("2026-06-01T06:00:00.000Z");

    const end = endOfMonthIn(t, tz);
    expect(end.toISOString()).toBe("2026-06-01T05:59:59.000Z");
  });

  it("computes calendar month boundaries in UTC", () => {
    const t = new Date("2026-05-08T17:33:56Z");
    expect(startOfMonthIn(t, "UTC").toISOString()).toBe(
      "2026-05-01T00:00:00.000Z",
    );
    expect(endOfMonthIn(t, "UTC").toISOString()).toBe(
      "2026-05-31T23:59:59.000Z",
    );
  });

  it("computes monthly anniversary periods at anchor day 15 in CDMX", () => {
    const anchor = new Date("2026-06-15T06:00:00Z"); // 00:00 CDMX 15-jun
    const tz = "America/Mexico_City";

    const p1 = anniversaryPeriodIn(anchor, anchor, tz);
    expect(p1.start.toISOString()).toBe("2026-06-15T06:00:00.000Z");
    expect(p1.end.toISOString()).toBe("2026-07-15T05:59:59.000Z");

    const p2 = anniversaryPeriodIn(
      anchor,
      new Date("2026-08-01T12:00:00Z"),
      tz,
    );
    // CDMX no longer observes DST (since 2022); always UTC-6.
    expect(p2.start.toISOString()).toBe("2026-07-15T06:00:00.000Z");
    expect(p2.end.toISOString()).toBe("2026-08-15T05:59:59.000Z");
  });

  it("clamps anchor day 31 to the last day of shorter months", () => {
    const anchor = new Date("2026-01-31T00:00:00Z");
    const tz = "UTC";
    const p = anniversaryPeriodIn(
      anchor,
      new Date("2026-02-15T00:00:00Z"),
      tz,
    );
    // From Jan 31 → Feb 28 (last day of Feb)
    expect(p.start.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-02-27T23:59:59.000Z");
  });

  it("survives a DST transition (US/Eastern spring-forward)", () => {
    // DST forward in US/Eastern: 2026-03-08 02:00 → 03:00.
    const before = new Date("2026-03-07T15:00:00Z");
    const after = new Date("2026-03-09T15:00:00Z");
    const wc1 = wallClockIn(before, "America/New_York");
    const wc2 = wallClockIn(after, "America/New_York");
    // Before DST: offset is -5 (EST); after: -4 (EDT).
    expect(wc1.hour).toBe(10); // 15-5=10
    expect(wc2.hour).toBe(11); // 15-4=11
  });
});
