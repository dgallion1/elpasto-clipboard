/**
 * Parse a UTC timestamp string into epoch milliseconds.
 *
 * Handles both the bare `YYYY-MM-DD HH:MM:SS` format produced by
 * SQLite's `datetime()` and any ISO-8601 string that already carries
 * timezone information (trailing "Z" or "+HH:MM" offset).
 *
 * Bare timestamps (no timezone suffix) are treated as UTC.
 */
export function parseUtcTimestamp(s: string): number {
  // If the string already ends with "Z", a "+" offset, or a "-" offset
  // in the timezone position, parse it directly.  Otherwise append "Z"
  // so the Date constructor treats it as UTC rather than local time.
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(s);
  return new Date(hasTimezone ? s : s + "Z").getTime();
}
