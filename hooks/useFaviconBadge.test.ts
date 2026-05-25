// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFaviconBadge } from "./useFaviconBadge";

function getFaviconHref(): string | null {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  return link?.href ?? null;
}

describe("useFaviconBadge", () => {
  let originalHidden: boolean;

  beforeEach(() => {
    originalHidden = document.hidden;
    // Remove any existing favicon link
    document.querySelector('link[rel="icon"]')?.remove();
  });

  afterEach(() => {
    Object.defineProperty(document, "hidden", {
      value: originalHidden,
      writable: true,
      configurable: true,
    });
    document.querySelector('link[rel="icon"]')?.remove();
  });

  it("does not badge when tab is visible", () => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    const { result } = renderHook(() => useFaviconBadge());

    act(() => {
      result.current();
    });

    // Should not have created a badge favicon
    const href = getFaviconHref();
    expect(href === null || !href.includes("ef4444")).toBe(true);
  });

  it("badges when tab is hidden", () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const { result } = renderHook(() => useFaviconBadge());

    act(() => {
      result.current();
    });

    const href = getFaviconHref();
    expect(href).toBeTruthy();
    expect(href).toContain("ef4444"); // red dot color
  });

  it("clears badge when tab becomes visible", () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const { result } = renderHook(() => useFaviconBadge());

    act(() => {
      result.current();
    });

    // Simulate tab becoming visible
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    const href = getFaviconHref();
    expect(href).toContain("/icon.svg");
  });

  it("restores favicon on unmount", () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const { result, unmount } = renderHook(() => useFaviconBadge());

    act(() => {
      result.current();
    });

    unmount();

    const href = getFaviconHref();
    expect(href).toContain("/icon.svg");
  });
});
