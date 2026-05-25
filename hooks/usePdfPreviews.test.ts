// @vitest-environment jsdom
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/zip-pdf", () => ({
  renderPdfPages: vi.fn(),
}));

import { renderPdfPages } from "@/lib/zip-pdf";
import { usePdfPreviews } from "./usePdfPreviews";

let urlCounter = 0;
const mockCreateObjectURL = vi.fn(() => `blob:pdf-${++urlCounter}`);
const mockRevokeObjectURL = vi.fn();
const mockRenderPdfPages = vi.mocked(renderPdfPages);

beforeEach(() => {
  urlCounter = 0;
  mockCreateObjectURL.mockClear();
  mockRevokeObjectURL.mockClear();
  mockRenderPdfPages.mockReset();
  globalThis.URL.createObjectURL = mockCreateObjectURL;
  globalThis.URL.revokeObjectURL = mockRevokeObjectURL;
});

afterEach(() => {
  cleanup();
});

function makePage(pageNum: number): {
  pageNum: number;
  data: Uint8Array;
  mimeType: "image/png";
} {
  return {
    pageNum,
    data: new Uint8Array([1, 2, 3, pageNum]),
    mimeType: "image/png",
  };
}

describe("usePdfPreviews", () => {
  test("returns IDLE when isPdf is false", () => {
    const blob = new Blob(["pretend pdf"]);
    const { result } = renderHook(() => usePdfPreviews(blob, false));
    expect(result.current).toEqual({
      pages: null,
      isLimited: false,
      isExtracting: false,
    });
    expect(mockRenderPdfPages).not.toHaveBeenCalled();
  });

  test("returns IDLE when source is null", () => {
    const { result } = renderHook(() => usePdfPreviews(null, true));
    expect(result.current.pages).toBeNull();
    expect(mockRenderPdfPages).not.toHaveBeenCalled();
  });

  test("emits empty pages when source exceeds 64MB size cap", async () => {
    // A blob larger than MAX_PDF_SOURCE_BYTES (64 MB). We don't need real
    // bytes — only `.size` is consulted before render is attempted.
    const oversized = new Blob([new Uint8Array(64 * 1024 * 1024 + 1)]);
    const { result } = renderHook(() => usePdfPreviews(oversized, true));

    await waitFor(() => {
      expect(result.current).toEqual({
        pages: [],
        isLimited: false,
        isExtracting: false,
      });
    });
    expect(mockRenderPdfPages).not.toHaveBeenCalled();
  });

  test("renders pages, creates blob URLs, and emits previews", async () => {
    mockRenderPdfPages.mockResolvedValue({
      pages: [makePage(1), makePage(2), makePage(3)],
      totalPageCount: 3,
    });

    const pdf = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], {
      type: "application/pdf",
    });
    const { result } = renderHook(() => usePdfPreviews(pdf, true));

    await waitFor(() => {
      expect(result.current.isExtracting).toBe(false);
      expect(result.current.pages).not.toBeNull();
    });

    expect(result.current.pages).toHaveLength(3);
    expect(result.current.isLimited).toBe(false);
    expect(result.current.pages![0]).toMatchObject({
      path: "#page=1",
      name: "p.1",
    });
    expect(result.current.pages![0].url).toMatch(/^blob:pdf-/);
    // 3 createObjectURL calls — one per page
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(3);
  });

  test("sets isLimited=true when fewer pages render than the PDF contains", async () => {
    mockRenderPdfPages.mockResolvedValue({
      pages: [makePage(1), makePage(2)],
      totalPageCount: 50,
    });

    const pdf = new Blob([new Uint8Array([1, 2, 3])], {
      type: "application/pdf",
    });
    const { result } = renderHook(() => usePdfPreviews(pdf, true));

    await waitFor(() => {
      expect(result.current.pages).not.toBeNull();
    });
    expect(result.current.isLimited).toBe(true);
    expect(result.current.pages).toHaveLength(2);
  });

  test("emits empty pages when renderPdfPages throws", async () => {
    mockRenderPdfPages.mockRejectedValue(new Error("corrupted PDF"));

    const pdf = new Blob([new Uint8Array([1, 2, 3])], {
      type: "application/pdf",
    });
    const { result } = renderHook(() => usePdfPreviews(pdf, true));

    await waitFor(() => {
      expect(result.current.isExtracting).toBe(false);
    });
    expect(result.current.pages).toEqual([]);
    expect(result.current.isLimited).toBe(false);
  });

  test("ignores resolution after unmount and revokes blob URLs in cleanup", async () => {
    // Deferred promise we control: lets us unmount before render settles.
    let resolveRender: (value: {
      pages: { pageNum: number; data: Uint8Array; mimeType: "image/png" }[];
      totalPageCount: number;
    }) => void = () => undefined;
    mockRenderPdfPages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRender = resolve;
        }),
    );

    const pdf = new Blob([new Uint8Array([1, 2, 3])], {
      type: "application/pdf",
    });
    const { result, unmount } = renderHook(() => usePdfPreviews(pdf, true));

    // The hook entered the extracting state synchronously after the effect.
    await waitFor(() => {
      expect(result.current.isExtracting).toBe(true);
    });

    unmount();

    // Resolve the render after unmount — the post-await `if (cancelled)`
    // guard must prevent any further state emissions or URL creation.
    resolveRender({
      pages: [makePage(1)],
      totalPageCount: 1,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Render path bailed at the first cancelled check, so no blob URLs
    // were created for this resolution.
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  test("revokes blob URLs from a prior render when source changes", async () => {
    mockRenderPdfPages.mockResolvedValueOnce({
      pages: [makePage(1), makePage(2)],
      totalPageCount: 2,
    });

    const first = new Blob([new Uint8Array([1])], { type: "application/pdf" });
    const { result, rerender } = renderHook(
      ({ source }: { source: Blob }) => usePdfPreviews(source, true),
      { initialProps: { source: first } },
    );

    await waitFor(() => {
      expect(result.current.pages).toHaveLength(2);
    });
    const initialUrls = result.current.pages!.map((p) => p.url);

    // Swap the source — the cleanup should revoke the two URLs from the first
    // render before the second effect kicks off.
    mockRenderPdfPages.mockResolvedValueOnce({
      pages: [makePage(1)],
      totalPageCount: 1,
    });
    const second = new Blob([new Uint8Array([2])], {
      type: "application/pdf",
    });
    rerender({ source: second });

    await waitFor(() => {
      expect(result.current.pages).toHaveLength(1);
    });

    for (const url of initialUrls) {
      expect(mockRevokeObjectURL).toHaveBeenCalledWith(url);
    }
  });

  test("aborts the in-flight render via AbortController when unmounted", async () => {
    let receivedSignal: AbortSignal | undefined;
    mockRenderPdfPages.mockImplementation(async (_bytes, opts) => {
      receivedSignal = opts?.signal;
      // Never resolves so the abort is the only outcome
      return new Promise(() => undefined);
    });

    const pdf = new Blob([new Uint8Array([1, 2, 3])], {
      type: "application/pdf",
    });
    const { unmount } = renderHook(() => usePdfPreviews(pdf, true));

    await waitFor(() => expect(receivedSignal).toBeDefined());
    expect(receivedSignal!.aborted).toBe(false);

    unmount();
    expect(receivedSignal!.aborted).toBe(true);
  });
});
