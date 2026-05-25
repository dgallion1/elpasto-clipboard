import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetDocument = vi.fn();

vi.mock("pdfjs-dist", () => ({
  getDocument: (input: unknown) => mockGetDocument(input),
}));

vi.mock("pdfjs-dist/build/pdf.worker.mjs", () => ({
  WorkerMessageHandler: {
    setup: vi.fn(),
  },
}));

import { renderPdfPages } from "./zip-pdf";

class MockOffscreenCanvas {
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return {};
  }

  convertToBlob() {
    return Promise.resolve(new Blob(["png-bytes"], { type: "image/png" }));
  }
}

const originalOffscreenCanvas = globalThis.OffscreenCanvas;

function setupMockPdf(numPages: number) {
  const mockPage = {
    getViewport: vi.fn(() => ({ width: 200, height: 300 })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    cleanup: vi.fn(),
  };
  const mockDocument = {
    numPages,
    getPage: vi.fn().mockResolvedValue(mockPage),
    destroy: vi.fn(),
  };

  mockGetDocument.mockReturnValue({
    promise: Promise.resolve(mockDocument),
  });

  return { mockDocument, mockPage };
}

beforeEach(() => {
  mockGetDocument.mockReset();
  globalThis.OffscreenCanvas =
    MockOffscreenCanvas as unknown as typeof OffscreenCanvas;
  delete (globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker;
});

afterEach(() => {
  if (originalOffscreenCanvas) {
    globalThis.OffscreenCanvas = originalOffscreenCanvas;
  } else {
    // @ts-expect-error deleting a global test shim
    delete globalThis.OffscreenCanvas;
  }
});

describe("renderPdfPages", () => {
  it("renders one preview per page", async () => {
    setupMockPdf(3);
    const pdfBytes = new Uint8Array([1, 2, 3]);

    const result = await renderPdfPages(pdfBytes);

    expect(mockGetDocument).toHaveBeenCalledWith({ data: pdfBytes });
    expect(result.totalPageCount).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.pages.map((page) => page.pageNum)).toEqual([1, 2, 3]);
    expect(result.pages.every((page) => page.mimeType === "image/png")).toBe(true);
  });

  it("respects maxPages", async () => {
    setupMockPdf(5);

    const result = await renderPdfPages(new Uint8Array([1]), { maxPages: 2 });

    expect(result.totalPageCount).toBe(5);
    expect(result.pages.map((page) => page.pageNum)).toEqual([1, 2]);
  });

  it("returns empty when loading fails", async () => {
    mockGetDocument.mockReturnValue({
      promise: Promise.reject(new Error("bad pdf")),
    });

    const result = await renderPdfPages(new Uint8Array([0]));

    expect(result).toEqual({ pages: [], totalPageCount: 0 });
  });

  it("returns empty when aborted before rendering", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await renderPdfPages(new Uint8Array([1]), {
      signal: controller.signal,
    });

    expect(result).toEqual({ pages: [], totalPageCount: 0 });
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  it("returns empty when OffscreenCanvas is unavailable", async () => {
    // @ts-expect-error deleting a global test shim
    delete globalThis.OffscreenCanvas;

    const result = await renderPdfPages(new Uint8Array([1]));

    expect(result).toEqual({ pages: [], totalPageCount: 0 });
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  it("destroys the PDF document and cleans up page resources", async () => {
    const { mockDocument, mockPage } = setupMockPdf(2);

    await renderPdfPages(new Uint8Array([1]));

    expect(mockDocument.destroy).toHaveBeenCalledTimes(1);
    expect(mockPage.cleanup).toHaveBeenCalledTimes(2);
  });
});
