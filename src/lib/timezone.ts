/**
 * Validates an IANA timezone identifier by asking the runtime to format a
 * date in that zone. Invalid zones throw `RangeError: Invalid time zone
 * specified`. Returns true iff the runtime accepts the zone.
 *
 * Mini-Lago canonical: organization + customer accept any IANA tz literal
 * (matches the D4 design decision). UTC is always valid.
 */
export function isValidIanaTimezone(tz: string): boolean {
  if (tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
