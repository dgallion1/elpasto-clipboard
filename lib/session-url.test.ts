// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { getSessionUrl } from "./session-url";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSessionUrl", () => {
  test("builds an absolute URL for the token with no query or hash", () => {
    vi.stubGlobal("window", {
      location: { href: "https://elpasto.app/old-token?x=1#frag" },
    } as unknown as Window);
    expect(getSessionUrl("elk-piano-river")).toBe("https://elpasto.app/elk-piano-river");
  });
});
