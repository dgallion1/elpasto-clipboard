// @vitest-environment jsdom
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zipSync, strToU8 } from "fflate";

vi.mock("@/lib/zip-pdf", () => ({
  renderPdfPages: vi.fn(),
}));

import { renderPdfPages } from "@/lib/zip-pdf";
import { useZipImagePreviews } from "./useZipImagePreviews";

let urlCounter = 0;
const mockCreateObjectURL = vi.fn(() => `blob:mock-url-${++urlCounter}`);
const mockRevokeObjectURL = vi.fn();
const mockRenderPdfPages = vi.mocked(renderPdfPages);

beforeEach(() => {
  urlCounter = 0;
  mockCreateObjectURL.mockClear();
  mockRevokeObjectURL.mockClear();
  mockRenderPdfPages.mockReset();
  mockRenderPdfPages.mockResolvedValue({ pages: [], totalPageCount: 0 });
  globalThis.URL.createObjectURL = mockCreateObjectURL;
  globalThis.URL.revokeObjectURL = mockRevokeObjectURL;
});

afterEach(() => {
  cleanup();
});

function makeZipBlob(files: Record<string, Uint8Array>): Blob {
  const data: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    data[path] = content;
  }
  const bytes = zipSync(data);
  return new Blob([new Uint8Array(bytes) as BlobPart], { type: "application/zip" });
}

describe("useZipImagePreviews", () => {
  it("returns images: null when isZip is false", () => {
    const blob = new Blob(["hello"]);
    const { result } = renderHook(() => useZipImagePreviews(blob, false));
    expect(result.current.images).toBeNull();
    expect(result.current.isLimited).toBe(false);
    expect(result.current.isExtracting).toBe(false);
  });

  it("returns images: null when source is null", () => {
    const { result } = renderHook(() => useZipImagePreviews(null, true));
    expect(result.current.images).toBeNull();
    expect(result.current.isLimited).toBe(false);
    expect(result.current.isExtracting).toBe(false);
  });

  it("extracts images from a valid zip blob and returns blob URLs", async () => {
    const zipBlob = makeZipBlob({
      "photo.png": new Uint8Array([137, 80, 78, 71]),
      "readme.txt": strToU8("hello"),
      "pic.jpg": new Uint8Array([255, 216, 255]),
    });

    const { result } = renderHook(() => useZipImagePreviews(zipBlob, true));

    await waitFor(() => {
      expect(result.current.images).not.toBeNull();
      expect(result.current.isExtracting).toBe(false);
    });

    expect(result.current.images).toHaveLength(2);
    expect(result.current.isLimited).toBe(false);
    expect(result.current.images!.map((i) => i.name).sort()).toEqual([
      "photo.png",
      "pic.jpg",
    ]);
    expect(result.current.images!.map((i) => i.path).sort()).toEqual([
      "photo.png",
      "pic.jpg",
    ]);
    // Each image should have a blob URL from createObjectURL
    for (const img of result.current.images!) {
      expect(img.url).toMatch(/^blob:mock-url-/);
    }
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(2);
  });

  it("returns images: [] for a zip with no image files", async () => {
    const zipBlob = makeZipBlob({
      "readme.txt": strToU8("hello"),
      "data.json": strToU8("{}"),
    });

    const { result } = renderHook(() => useZipImagePreviews(zipBlob, true));

    await waitFor(() => {
      expect(result.current.isExtracting).toBe(false);
      expect(result.current.images).not.toBeNull();
    });

    expect(result.current.images).toEqual([]);
    expect(result.current.isLimited).toBe(false);
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it("revokes blob URLs on unmount", async () => {
    const zipBlob = makeZipBlob({
      "a.png": new Uint8Array([137, 80, 78, 71]),
      "b.jpg": new Uint8Array([255, 216, 255]),
    });

    const { result, unmount } = renderHook(() =>
      useZipImagePreviews(zipBlob, true),
    );

    await waitFor(() => {
      expect(result.current.images).not.toBeNull();
      expect(result.current.images!.length).toBe(2);
    });

    const urls = result.current.images!.map((i) => i.url);
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();

    unmount();

    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(2);
    for (const url of urls) {
      expect(mockRevokeObjectURL).toHaveBeenCalledWith(url);
    }
  });

  it("uses full paths as labels when duplicate basenames are previewed", async () => {
    const zipBlob = makeZipBlob({
      "cats/photo.png": new Uint8Array([1]),
      "dogs/photo.png": new Uint8Array([2]),
    });

    const { result } = renderHook(() => useZipImagePreviews(zipBlob, true));

    await waitFor(() => {
      expect(result.current.images).not.toBeNull();
      expect(result.current.isExtracting).toBe(false);
    });

    expect(result.current.images!.map((i) => i.path)).toEqual([
      "cats/photo.png",
      "dogs/photo.png",
    ]);
    expect(result.current.images!.map((i) => i.name)).toEqual([
      "cats/photo.png",
      "dogs/photo.png",
    ]);
  });

  it("skips preview extraction for very large zip blobs", () => {
    const zipBlob = new Blob(["tiny"], { type: "application/zip" });
    Object.defineProperty(zipBlob, "size", { value: 513 * 1024 * 1024 });

    const { result } = renderHook(() => useZipImagePreviews(zipBlob, true));

    expect(result.current.images).toEqual([]);
    expect(result.current.isLimited).toBe(false);
    expect(result.current.isExtracting).toBe(false);
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it("expands PDF entries into per-page previews", async () => {
    mockRenderPdfPages.mockResolvedValue({
      pages: [
        { pageNum: 1, data: new Uint8Array([10]), mimeType: "image/png" },
        { pageNum: 2, data: new Uint8Array([20]), mimeType: "image/png" },
      ],
      totalPageCount: 2,
    });

    const zipBlob = makeZipBlob({
      "a-image.png": new Uint8Array([137, 80, 78, 71]),
      "b-doc.pdf": new Uint8Array([37, 80, 68, 70]),
    });

    const { result } = renderHook(() => useZipImagePreviews(zipBlob, true));

    await waitFor(() => {
      expect(result.current.images).not.toBeNull();
      expect(result.current.isExtracting).toBe(false);
    });

    expect(result.current.isLimited).toBe(false);
    expect(result.current.images).toHaveLength(3);
    expect(result.current.images!.map((image) => image.path)).toEqual([
      "a-image.png",
      "b-doc.pdf#page=1",
      "b-doc.pdf#page=2",
    ]);
    expect(result.current.images!.map((image) => image.name)).toEqual([
      "a-image.png",
      "b-doc.pdf p.1",
      "b-doc.pdf p.2",
    ]);
    expect(mockRenderPdfPages).toHaveBeenCalledOnce();
  });

  it("falls back to full PDF paths when duplicate page labels collide", async () => {
    mockRenderPdfPages.mockResolvedValue({
      pages: [
        { pageNum: 1, data: new Uint8Array([10]), mimeType: "image/png" },
      ],
      totalPageCount: 1,
    });

    const zipBlob = makeZipBlob({
      "cats/report.pdf": new Uint8Array([1]),
      "dogs/report.pdf": new Uint8Array([2]),
    });

    const { result } = renderHook(() => useZipImagePreviews(zipBlob, true));

    await waitFor(() => {
      expect(result.current.images).not.toBeNull();
      expect(result.current.isExtracting).toBe(false);
    });

    expect(result.current.images!.map((image) => image.name)).toEqual([
      "cats/report.pdf p.1",
      "dogs/report.pdf p.1",
    ]);
  });

  it("marks the preview as limited when PDF pages exceed remaining slots", async () => {
    mockRenderPdfPages.mockResolvedValue({
      pages: Array.from({ length: 19 }, (_, index) => ({
        pageNum: index + 1,
        data: new Uint8Array([index + 1]),
        mimeType: "image/png" as const,
      })),
      totalPageCount: 25,
    });

    const zipBlob = makeZipBlob({
      "a-image.png": new Uint8Array([137, 80, 78, 71]),
      "b-doc.pdf": new Uint8Array([37, 80, 68, 70]),
    });

    const { result } = renderHook(() => useZipImagePreviews(zipBlob, true));

    await waitFor(() => {
      expect(result.current.images).not.toBeNull();
      expect(result.current.isExtracting).toBe(false);
    });

    expect(result.current.images).toHaveLength(20);
    expect(result.current.isLimited).toBe(true);
  });

  it("skips PDFs that fail to render without breaking image previews", async () => {
    mockRenderPdfPages.mockResolvedValue({ pages: [], totalPageCount: 0 });

    const zipBlob = makeZipBlob({
      "photo.png": new Uint8Array([137, 80, 78, 71]),
      "bad.pdf": new Uint8Array([0, 0, 0]),
    });

    const { result } = renderHook(() => useZipImagePreviews(zipBlob, true));

    await waitFor(() => {
      expect(result.current.images).not.toBeNull();
      expect(result.current.isExtracting).toBe(false);
    });

    expect(result.current.images).toHaveLength(1);
    expect(result.current.images![0].name).toBe("photo.png");
    expect(result.current.isLimited).toBe(false);
  });
});
