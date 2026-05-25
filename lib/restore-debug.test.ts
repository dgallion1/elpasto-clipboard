// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let isRestoreDebugEnabled: typeof import("./restore-debug").isRestoreDebugEnabled;
let logRestoreDebug: typeof import("./restore-debug").logRestoreDebug;

beforeEach(async () => {
  vi.resetModules();
  window.sessionStorage.clear();
  window.localStorage.clear();
  ({ isRestoreDebugEnabled, logRestoreDebug } = await import("./restore-debug"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isRestoreDebugEnabled", () => {
  test("returns false when no flags are set", () => {
    expect(isRestoreDebugEnabled()).toBe(false);
  });

  test("returns true when sessionStorage flag is set to 1", () => {
    window.sessionStorage.setItem("elpasto:debug:restore", "1");
    expect(isRestoreDebugEnabled()).toBe(true);
  });

  test("returns true when localStorage flag is set to true", () => {
    window.localStorage.setItem("elpasto:debug:restore", "true");
    expect(isRestoreDebugEnabled()).toBe(true);
  });

  test("returns true when debugRestore query param is present", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, search: "?debugRestore" },
    });
    expect(isRestoreDebugEnabled()).toBe(true);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, search: "" },
    });
  });

  test("returns false for non-truthy flag values", () => {
    window.sessionStorage.setItem("elpasto:debug:restore", "0");
    expect(isRestoreDebugEnabled()).toBe(false);
  });

  test("returns false when storage throws", () => {
    // Replace the storage objects themselves to ensure the throw reaches readDebugFlag's catch
    const origSession = window.sessionStorage;
    const origLocal = window.localStorage;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        return {
          getItem() { throw new Error("session storage error"); },
          setItem() {},
          removeItem() {},
          clear() {},
          length: 0,
          key() { return null; },
        };
      },
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        return {
          getItem() { throw new Error("local storage error"); },
          setItem() {},
          removeItem() {},
          clear() {},
          length: 0,
          key() { return null; },
        };
      },
    });
    expect(isRestoreDebugEnabled()).toBe(false);
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: origSession,
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: origLocal,
    });
  });
});

describe("logRestoreDebug", () => {
  test("does nothing when debug is disabled", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logRestoreDebug("test", "some event", { key: "value" });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  test("logs prefix and details when debug is enabled", () => {
    window.sessionStorage.setItem("elpasto:debug:restore", "1");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logRestoreDebug("test-scope", "some event", { key: "value" });
    expect(consoleSpy).toHaveBeenCalledWith(
      "[elpasto:restore:test-scope] some event",
      { key: "value" },
    );
  });

  test("logs prefix only when details is undefined", () => {
    window.sessionStorage.setItem("elpasto:debug:restore", "1");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logRestoreDebug("scope", "no details");
    expect(consoleSpy).toHaveBeenCalledWith("[elpasto:restore:scope] no details");
  });

  test("logs prefix only when details is empty object", () => {
    window.sessionStorage.setItem("elpasto:debug:restore", "1");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logRestoreDebug("scope", "empty details", {});
    expect(consoleSpy).toHaveBeenCalledWith("[elpasto:restore:scope] empty details");
  });
});
