// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  copyHtml,
  copyImageBlob,
  copyImageFromUrl,
  copyText,
  useClipboardCapabilities,
} from "./useClipboard";

class ClipboardItemMock {
  static shouldThrow = false;
  items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    if (ClipboardItemMock.shouldThrow) {
      throw new Error("unsupported");
    }
    this.items = items;
  }
}

class MockImage {
  static mode: "load" | "error" = "load";
  width = 10;
  height = 20;
  onload: (() => void) | null = null;
  onerror: ((error: Error) => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => {
      if (MockImage.mode === "error") {
        this.onerror?.(new Error("image failed"));
      } else {
        this.onload?.();
      }
    });
  }
}

const writeMock = vi.fn();
const writeTextMock = vi.fn();
const fetchMock = vi.fn();
const createObjectURLMock = vi.fn(() => "blob://test");
const revokeObjectURLMock = vi.fn();

let canvasContext: { drawImage: ReturnType<typeof vi.fn> } | null;
let canvasBlob: Blob | null;
const originalCreateElement = document.createElement.bind(document);

beforeEach(() => {
  writeMock.mockReset();
  writeTextMock.mockReset();
  fetchMock.mockReset();
  createObjectURLMock.mockReset();
  createObjectURLMock.mockReturnValue("blob://test");
  revokeObjectURLMock.mockReset();
  canvasContext = { drawImage: vi.fn() };
  canvasBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  ClipboardItemMock.shouldThrow = false;
  MockImage.mode = "load";

  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value: ClipboardItemMock,
  });
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: MockImage,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchMock,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        write: writeMock,
        writeText: writeTextMock,
      },
    },
  });
  Object.defineProperty(globalThis.URL, "createObjectURL", {
    configurable: true,
    value: createObjectURLMock,
  });
  Object.defineProperty(globalThis.URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURLMock,
  });

  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    if (tagName === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext: vi.fn(() => canvasContext),
        toBlob: (callback: (blob: Blob | null) => void) => callback(canvasBlob),
      } as unknown as HTMLCanvasElement;
    }
    return originalCreateElement(tagName);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useClipboard", () => {
  test("detects rich and image copy support", async () => {
    const { result } = renderHook(() => useClipboardCapabilities());

    await waitFor(() => {
      expect(result.current).toEqual({ canCopyRich: true, canCopyImage: true });
    });
  });

  test("handles missing clipboard APIs and image constructor failures", async () => {
    ClipboardItemMock.shouldThrow = true;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { write: writeMock, writeText: writeTextMock } },
    });

    const { result } = renderHook(() => useClipboardCapabilities());
    await waitFor(() => {
      expect(result.current).toEqual({ canCopyRich: true, canCopyImage: false });
    });

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    const { result: missing } = renderHook(() => useClipboardCapabilities());
    await waitFor(() => {
      expect(missing.current).toEqual({ canCopyRich: false, canCopyImage: false });
    });
  });

  test("copies plain text and rich html with fallbacks", async () => {
    writeTextMock.mockResolvedValueOnce(undefined);
    expect(await copyText("hello")).toBe(true);

    writeTextMock.mockRejectedValueOnce(new Error("denied"));
    expect(await copyText("hello")).toBe(false);

    writeMock.mockResolvedValueOnce(undefined);
    expect(await copyHtml("<b>hi</b>", "hi")).toBe("rich");

    writeMock.mockRejectedValueOnce(new Error("fail"));
    writeTextMock.mockResolvedValueOnce(undefined);
    expect(await copyHtml("<b>hi</b>", "hi")).toBe("plain");

    writeMock.mockRejectedValueOnce(new Error("fail"));
    writeTextMock.mockRejectedValueOnce(new Error("fail"));
    expect(await copyHtml("<b>hi</b>", "hi")).toBe(false);
  });

  test("copies images from url and as png blobs", async () => {
    const pngBlob = new Blob([new Uint8Array([1])], { type: "image/png" });
    fetchMock.mockResolvedValueOnce({
      blob: async () => pngBlob,
    });
    writeMock.mockResolvedValue(undefined);

    expect(await copyImageFromUrl("/image.png")).toBe(true);
    expect(await copyImageBlob(pngBlob)).toBe(true);
  });

  test("returns false when image fetch or clipboard write fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    expect(await copyImageFromUrl("/missing.png")).toBe(false);

    writeMock.mockRejectedValueOnce(new Error("clipboard"));
    expect(await copyImageBlob(new Blob([new Uint8Array([1])], { type: "image/png" }))).toBe(false);
  });

  test("converts non-png blobs and handles conversion failures", async () => {
    writeMock.mockResolvedValue(undefined);
    expect(await copyImageBlob(new Blob([new Uint8Array([1])], { type: "image/jpeg" }))).toBe(true);
    expect(createObjectURLMock).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalled();

    canvasContext = null;
    expect(await copyImageBlob(new Blob([new Uint8Array([1])], { type: "image/jpeg" }))).toBe(false);

    canvasContext = { drawImage: vi.fn() };
    canvasBlob = null;
    expect(await copyImageBlob(new Blob([new Uint8Array([1])], { type: "image/jpeg" }))).toBe(false);

    canvasBlob = new Blob([new Uint8Array([1])], { type: "image/png" });
    MockImage.mode = "error";
    expect(await copyImageBlob(new Blob([new Uint8Array([1])], { type: "image/jpeg" }))).toBe(false);
  });
});
