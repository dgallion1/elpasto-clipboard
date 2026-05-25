import { describe, expect, test } from "vitest";
import { parseUtcTimestamp } from "./time";

describe("parseUtcTimestamp", () => {
  test("parses bare SQLite datetime as UTC", () => {
    const ms = parseUtcTimestamp("2024-06-15 12:30:00");
    expect(new Date(ms).toISOString()).toBe("2024-06-15T12:30:00.000Z");
  });

  test("parses ISO string with Z suffix", () => {
    const ms = parseUtcTimestamp("2024-06-15T12:30:00.000Z");
    expect(new Date(ms).toISOString()).toBe("2024-06-15T12:30:00.000Z");
  });

  test("parses ISO string with positive offset", () => {
    const ms = parseUtcTimestamp("2024-06-15T14:30:00+02:00");
    expect(new Date(ms).toISOString()).toBe("2024-06-15T12:30:00.000Z");
  });

  test("parses ISO string with negative offset", () => {
    const ms = parseUtcTimestamp("2024-06-15T07:30:00-05:00");
    expect(new Date(ms).toISOString()).toBe("2024-06-15T12:30:00.000Z");
  });

  test("returns NaN for garbage input", () => {
    expect(parseUtcTimestamp("not-a-date")).toBeNaN();
  });
});
