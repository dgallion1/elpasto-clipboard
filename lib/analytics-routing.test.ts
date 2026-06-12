import { describe, test, expect } from "vitest";
import { shouldLoadAnalytics } from "@/lib/analytics-routing";

describe("shouldLoadAnalytics (M2 — no analytics on secret-bearing routes)", () => {
  test("allows the public landing page", () => {
    expect(shouldLoadAnalytics("/")).toBe(true);
  });

  test("blocks session token routes (token is in the path)", () => {
    expect(shouldLoadAnalytics("/year-lens-femur-drift-cable")).toBe(false);
    expect(shouldLoadAnalytics("/any-capability-token")).toBe(false);
  });

  test("blocks tunnel routes", () => {
    expect(shouldLoadAnalytics("/tunnel/peer-1")).toBe(false);
    expect(shouldLoadAnalytics("/tunnel-view/peer-1/some/path")).toBe(false);
  });

  test("blocks the stats dashboard (key is in the query)", () => {
    expect(shouldLoadAnalytics("/stats")).toBe(false);
  });
});
