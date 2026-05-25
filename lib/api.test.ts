import { afterEach, describe, expect, test, vi } from "vitest";

async function importApiModule(apiBaseUrl?: string, goBackendPort?: string) {
  vi.resetModules();

  if (apiBaseUrl === undefined) {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
  } else {
    process.env.NEXT_PUBLIC_API_BASE_URL = apiBaseUrl;
  }

  if (goBackendPort === undefined) {
    delete process.env.NEXT_PUBLIC_GO_BACKEND_PORT;
  } else {
    process.env.NEXT_PUBLIC_GO_BACKEND_PORT = goBackendPort;
  }

  return import("./api");
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_API_BASE_URL;
  delete process.env.NEXT_PUBLIC_GO_BACKEND_PORT;
  vi.resetModules();
});

describe("lib/api", () => {
  test("buildApiUrl normalizes paths and optional api suffixes", async () => {
    let api = await importApiModule();
    expect(api.buildApiUrl("sessions")).toBe("/sessions");

    api = await importApiModule(" https://example.com/base// ");
    expect(api.buildApiUrl("/api/sessions")).toBe("https://example.com/base/api/sessions");

    api = await importApiModule("https://example.com/api/");
    expect(api.buildApiUrl("/api/sessions")).toBe("https://example.com/api/sessions");
    expect(api.buildApiUrl("/api")).toBe("https://example.com/api");
  });

  test("buildSseUrl uses the go backend port when configured", async () => {
    let api = await importApiModule("https://example.com/api", "4300");
    expect(api.buildSseUrl("api/sessions/demo/events")).toBe("http://localhost:4300/api/sessions/demo/events");

    api = await importApiModule("https://example.com/api");
    expect(api.buildSseUrl("/api/sessions/demo/events")).toBe("https://example.com/api/sessions/demo/events");
  });
});
