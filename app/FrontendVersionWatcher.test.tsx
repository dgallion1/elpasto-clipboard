// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FrontendVersionWatcher } from "./FrontendVersionWatcher";

describe("FrontendVersionWatcher", () => {
  beforeEach(() => {
    window.__ELPASTO_BUILD_ID__ = "build-a";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete window.__ELPASTO_BUILD_ID__;
  });

  test("does not reload when the deployed build matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "build-a",
    });
    const reloadMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);
    render(<FrontendVersionWatcher reloadPage={reloadMock} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/__elpasto/version", {
        cache: "no-store",
      });
    });
    expect(reloadMock).not.toHaveBeenCalled();
  });

  test("does not poll when no build id was injected", async () => {
    const fetchMock = vi.fn();
    const reloadMock = vi.fn();

    delete window.__ELPASTO_BUILD_ID__;
    vi.stubGlobal("fetch", fetchMock);
    render(<FrontendVersionWatcher reloadPage={reloadMock} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  test("reloads when the deployed build changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "build-b",
    });
    const reloadMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);
    render(<FrontendVersionWatcher reloadPage={reloadMock} />);

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });
  });

  test("checks again when the page becomes visible", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "build-a",
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<FrontendVersionWatcher reloadPage={vi.fn()} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test("handles non-ok fetch response without reloading", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    const reloadMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);
    render(<FrontendVersionWatcher reloadPage={reloadMock} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(reloadMock).not.toHaveBeenCalled();
  });

  test("handles empty latestBuild text without crashing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "   ",
    });
    const reloadMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);
    render(<FrontendVersionWatcher reloadPage={reloadMock} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(reloadMock).not.toHaveBeenCalled();
  });

  test("does not fire visibility check when document is hidden", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "build-a",
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<FrontendVersionWatcher reloadPage={vi.fn()} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    // Give it a tick to ensure no extra call
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Restore
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  test("cleans up interval and event listeners on unmount", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "build-a",
    });
    const reloadMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<FrontendVersionWatcher reloadPage={reloadMock} />);

    await act(async () => {
      await Promise.resolve();
    });

    const callCountBeforeUnmount = fetchMock.mock.calls.length;
    unmount();

    // Advance past the interval — no new calls should happen
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(callCountBeforeUnmount);
  });

  test("calls window.location.reload when no reloadPage prop is passed", async () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload: reloadMock },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "build-b",
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<FrontendVersionWatcher />);

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });
  });

  test("ignores rejected version checks and keeps polling", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        ok: true,
        text: async () => "build-a",
      });
    const reloadMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);
    render(<FrontendVersionWatcher reloadPage={reloadMock} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reloadMock).not.toHaveBeenCalled();
  });
});
