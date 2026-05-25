// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { ClipCryptoError } from "@/lib/clip-crypto";
import type { Clip, ClipKind } from "@/lib/clips";
import type { RefObject } from "react";
import { usePasteZoneActions, type UsePasteZoneActionsParams } from "./usePasteZoneActions";

// Helper that passes makeParams result through usePasteZoneActions with a safe cast.
// The mock shapes don't exactly match the callback signatures, but the runtime
// behavior is correct — vi.fn() accepts any arguments.
function useActions(params: ReturnType<typeof makeParams>) {
  return usePasteZoneActions(params as unknown as UsePasteZoneActionsParams);
}

// Stable mock params factory
function makeParams(overrides: Record<string, unknown> = {}) {
  const onClipAdded = vi.fn();
  const onQueueLocalBinaryClip = vi.fn().mockImplementation(async ({
    transferId,
    zone,
    file,
    kind,
  }: {
    transferId: string;
    zone: "A" | "B";
    file: File;
    kind?: ClipKind;
  }) => ({
    id: -1,
    session_id: 0,
    zone,
    kind: kind || ("text" as ClipKind),
    client_transfer_id: transferId,
    mime_type: file.type,
    text_content: null,
    html_content: null,
    storage_key: null,
    original_name: file.name,
    size_bytes: file.size,
    encrypted: false,
    encryption_version: null,
    encryption_meta: null,
    created_at: "2026-03-08T10:00:00Z",
    local_only: true,
    local_origin: "sender",
    local_transfer_state: "complete",
    local_file: file,
  } satisfies Clip));
  const onClearZone = vi.fn().mockResolvedValue(undefined);
  const setError = vi.fn();
  const setIsClearing = vi.fn();
  const setIsDragOver = vi.fn();
  const onSessionImportDetected = vi.fn();
  const fileInputRef = { current: null } as RefObject<HTMLInputElement | null>;

  return {
    zone: "A" as const,
    unlockSecret: null as string | null,
    secretHandle: undefined,
    onClipAdded,
    onQueueLocalBinaryClip,
    onClearZone,
    onImportSessions: undefined as UsePasteZoneActionsParams["onImportSessions"],
    fileInputRef,
    setError,
    setIsClearing,
    setIsDragOver,
    onSessionImportDetected,
    ...overrides,
  };
}

let randomUuidSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  randomUuidSpy = vi.spyOn(globalThis.crypto, "randomUUID");
  randomUuidSpy.mockReturnValue("test-uuid-123");
});

afterEach(() => {
  randomUuidSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("usePasteZoneActions", () => {
  // ----------------------------------------------------------------
  // handlePaste — no clipboardData / no items
  // ----------------------------------------------------------------
  test("handlePaste returns early when clipboardData has no items", () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = {
      clipboardData: { items: null, getData: () => "" },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    act(() => result.current.handlePaste(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });

  test("handlePaste returns early when clipboardData is undefined", () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = {
      clipboardData: undefined,
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    act(() => result.current.handlePaste(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // handlePaste — file item where getAsFile returns null
  // ----------------------------------------------------------------
  test("handlePaste skips file item when getAsFile returns null, falls through to text", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => null }],
        getData: (type: string) => (type === "text/plain" ? "fallback text" : ""),
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => result.current.handlePaste(event));

    // Should fall through to the text path
    expect(event.preventDefault).toHaveBeenCalled();
    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
    const args = params.onQueueLocalBinaryClip.mock.calls[0][0];
    expect(args.kind).toBe("text");
  });

  // ----------------------------------------------------------------
  // handlePaste — text only (no HTML)
  // ----------------------------------------------------------------
  test("handlePaste with plain text only (no html) creates a text clip", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === "text/plain" ? "hello" : ""),
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => result.current.handlePaste(event));

    expect(event.preventDefault).toHaveBeenCalled();
    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
    const args = params.onQueueLocalBinaryClip.mock.calls[0][0];
    expect(args.kind).toBe("text");
    expect(args.file.name).toBe("clip.txt");
  });

  // ----------------------------------------------------------------
  // handlePaste — text that is session import JSON (with onImportSessions)
  // ----------------------------------------------------------------
  test("handlePaste with session JSON text calls onSessionImportDetected", async () => {
    const sessionJson = JSON.stringify({
      type: "elpasto:sessions",
      version: 1,
      sessions: [{ token: "amber-anchor-apple-arch-arrow", label: null, pinned: false, lastVisited: 0 }],
    });
    const onSessionImportDetected = vi.fn();
    const params = makeParams({
      onImportSessions: vi.fn(),
      onSessionImportDetected,
    });
    const { result } = renderHook(() => useActions(params));

    const event = {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === "text/plain" ? sessionJson : ""),
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => result.current.handlePaste(event));

    expect(onSessionImportDetected).toHaveBeenCalled();
    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // handleImportedSessionText returns false when onImportSessions is undefined
  // ----------------------------------------------------------------
  test("handlePaste falls through to addTextClip when onImportSessions is undefined even for session JSON", async () => {
    const sessionJson = JSON.stringify({
      type: "elpasto:sessions",
      version: 1,
      sessions: [{ token: "amber-anchor-apple-arch-arrow", label: null, pinned: false, lastVisited: 0 }],
    });
    const params = makeParams({ onImportSessions: undefined });
    const { result } = renderHook(() => useActions(params));

    const event = {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === "text/plain" ? sessionJson : ""),
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => result.current.handlePaste(event));

    // Since onImportSessions is undefined, handleImportedSessionText returns false
    // and addTextClip is called instead
    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------
  // handleDrop — with files
  // ----------------------------------------------------------------
  test("handleDrop with files calls addFileClip for each file", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const file1 = new File(["a"], "a.png", { type: "image/png" });
    const file2 = new File(["b"], "b.txt", { type: "text/plain" });
    const event = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: [file1, file2],
        getData: () => "",
      },
    } as unknown as React.DragEvent;

    // Make files iterable
    Object.defineProperty(event.dataTransfer.files, "length", { value: 2 });
    Object.defineProperty(event.dataTransfer.files, Symbol.iterator, {
      value: function* () { yield file1; yield file2; },
    });

    await act(async () => result.current.handleDrop(event));

    expect(event.preventDefault).toHaveBeenCalled();
    expect(params.setIsDragOver).toHaveBeenCalledWith(false);
    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(2);
  });

  // ----------------------------------------------------------------
  // handleDrop — text that is session import JSON
  // ----------------------------------------------------------------
  test("handleDrop with session JSON text triggers import detection", async () => {
    const sessionJson = JSON.stringify({
      type: "elpasto:sessions",
      version: 1,
      sessions: [{ token: "amber-anchor-apple-arch-arrow" }],
    });
    const onSessionImportDetected = vi.fn();
    const params = makeParams({
      onImportSessions: vi.fn(),
      onSessionImportDetected,
    });
    const { result } = renderHook(() => useActions(params));

    const event = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: { length: 0, [Symbol.iterator]: function* () {} },
        getData: (type: string) => (type === "text/plain" ? sessionJson : ""),
      },
    } as unknown as React.DragEvent;

    await act(async () => result.current.handleDrop(event));

    expect(onSessionImportDetected).toHaveBeenCalled();
    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // handleDrop — text only (no files, no import)
  // ----------------------------------------------------------------
  test("handleDrop with plain text and no files creates a text clip", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: { length: 0, [Symbol.iterator]: function* () {} },
        getData: (type: string) => (type === "text/plain" ? "dropped text" : ""),
      },
    } as unknown as React.DragEvent;

    await act(async () => result.current.handleDrop(event));

    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------
  // handleDrop — no files, no text (empty drop)
  // ----------------------------------------------------------------
  test("handleDrop with no files and no text does nothing", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: { length: 0, [Symbol.iterator]: function* () {} },
        getData: () => "",
      },
    } as unknown as React.DragEvent;

    await act(async () => result.current.handleDrop(event));

    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // handleDragOver
  // ----------------------------------------------------------------
  test("handleDragOver prevents default and sets isDragOver", () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = { preventDefault: vi.fn() } as unknown as React.DragEvent;
    act(() => result.current.handleDragOver(event));

    expect(event.preventDefault).toHaveBeenCalled();
    expect(params.setIsDragOver).toHaveBeenCalledWith(true);
  });

  // ----------------------------------------------------------------
  // handleDragLeave
  // ----------------------------------------------------------------
  test("handleDragLeave clears isDragOver", () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    act(() => result.current.handleDragLeave());
    expect(params.setIsDragOver).toHaveBeenCalledWith(false);
  });

  // ----------------------------------------------------------------
  // readClipboard — navigator.clipboard.read with image
  // ----------------------------------------------------------------
  test("readClipboard reads image from clipboard.read()", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const mockBlob = new Blob(["img"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["image/png"],
            getType: vi.fn().mockResolvedValue(mockBlob),
          },
        ]),
      },
      writable: true,
      configurable: true,
    });

    await act(async () => result.current.readClipboard());

    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
    const args = params.onQueueLocalBinaryClip.mock.calls[0][0];
    expect(args.kind).toBe("image");
    expect(args.file.name).toBe("pasted-image.png");
  });

  // ----------------------------------------------------------------
  // readClipboard — navigator.clipboard.read with HTML + text
  // ----------------------------------------------------------------
  test("readClipboard reads html+text from clipboard.read()", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const htmlBlob = new Blob(["<b>bold</b>"], { type: "text/html" });
    const textBlob = new Blob(["bold"], { type: "text/plain" });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["text/html", "text/plain"],
            getType: vi.fn().mockImplementation((type: string) =>
              type === "text/html" ? Promise.resolve(htmlBlob) : Promise.resolve(textBlob)
            ),
          },
        ]),
      },
      writable: true,
      configurable: true,
    });

    await act(async () => result.current.readClipboard());

    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
    const args = params.onQueueLocalBinaryClip.mock.calls[0][0];
    expect(args.kind).toBe("html");
    expect(args.file.name).toBe("clip.json");
  });

  // ----------------------------------------------------------------
  // readClipboard — navigator.clipboard.read with text only
  // ----------------------------------------------------------------
  test("readClipboard reads plain text from clipboard.read()", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const textBlob = new Blob(["hello clipboard"], { type: "text/plain" });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["text/plain"],
            getType: vi.fn().mockResolvedValue(textBlob),
          },
        ]),
      },
      writable: true,
      configurable: true,
    });

    await act(async () => result.current.readClipboard());

    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
    const args = params.onQueueLocalBinaryClip.mock.calls[0][0];
    expect(args.kind).toBe("text");
  });

  // ----------------------------------------------------------------
  // readClipboard — text is session JSON (import detection)
  // ----------------------------------------------------------------
  test("readClipboard with session JSON text from clipboard.read() triggers import detection", async () => {
    const sessionJson = JSON.stringify({
      type: "elpasto:sessions",
      version: 1,
      sessions: [{ token: "amber-anchor-apple-arch-arrow" }],
    });
    const onSessionImportDetected = vi.fn();
    const params = makeParams({
      onImportSessions: vi.fn(),
      onSessionImportDetected,
    });
    const { result } = renderHook(() => useActions(params));

    const textBlob = new Blob([sessionJson], { type: "text/plain" });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["text/plain"],
            getType: vi.fn().mockResolvedValue(textBlob),
          },
        ]),
      },
      writable: true,
      configurable: true,
    });

    await act(async () => result.current.readClipboard());

    expect(onSessionImportDetected).toHaveBeenCalled();
    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // readClipboard — fallback to readText
  // ----------------------------------------------------------------
  test("readClipboard falls back to readText when read() is unavailable", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: undefined,
        readText: vi.fn().mockResolvedValue("fallback text"),
      },
      writable: true,
      configurable: true,
    });

    await act(async () => result.current.readClipboard());

    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
    const args = params.onQueueLocalBinaryClip.mock.calls[0][0];
    expect(args.kind).toBe("text");
  });

  // ----------------------------------------------------------------
  // readClipboard — fallback readText returns empty string
  // ----------------------------------------------------------------
  test("readClipboard readText fallback does nothing on empty text", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: undefined,
        readText: vi.fn().mockResolvedValue(""),
      },
      writable: true,
      configurable: true,
    });

    await act(async () => result.current.readClipboard());

    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // readClipboard — fallback readText with session JSON
  // ----------------------------------------------------------------
  test("readClipboard readText fallback detects session import JSON", async () => {
    const sessionJson = JSON.stringify({
      type: "elpasto:sessions",
      version: 1,
      sessions: [{ token: "amber-anchor-apple-arch-arrow" }],
    });
    const onSessionImportDetected = vi.fn();
    const params = makeParams({
      onImportSessions: vi.fn(),
      onSessionImportDetected,
    });
    const { result } = renderHook(() => useActions(params));

    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: undefined,
        readText: vi.fn().mockResolvedValue(sessionJson),
      },
      writable: true,
      configurable: true,
    });

    await act(async () => result.current.readClipboard());

    expect(onSessionImportDetected).toHaveBeenCalled();
    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // readClipboard — clipboard access denied (error branch)
  // ----------------------------------------------------------------
  test("readClipboard sets error on clipboard access denied", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: vi.fn().mockRejectedValue(new DOMException("denied")),
      },
      writable: true,
      configurable: true,
    });

    await act(async () => result.current.readClipboard());

    expect(params.setError).toHaveBeenCalledWith(
      "Clipboard access denied. Use the compose field to paste content."
    );
  });

  // ----------------------------------------------------------------
  // readClipboard — clipboard.read returns item with no matching types
  // ----------------------------------------------------------------
  test("readClipboard does nothing when clipboard item has no recognized types", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["application/x-custom"],
            getType: vi.fn(),
          },
        ]),
      },
      writable: true,
      configurable: true,
    });

    await act(async () => result.current.readClipboard());

    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // openFilePicker — null ref
  // ----------------------------------------------------------------
  test("openFilePicker does nothing when fileInputRef.current is null", () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    // fileInputRef.current is already null
    expect(() => result.current.openFilePicker()).not.toThrow();
  });

  // ----------------------------------------------------------------
  // openFilePicker — with element
  // ----------------------------------------------------------------
  test("openFilePicker clicks the file input element", () => {
    const click = vi.fn();
    const params = makeParams({
      fileInputRef: { current: { click } },
    });
    const { result } = renderHook(() => useActions(params));

    result.current.openFilePicker();
    expect(click).toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // submitTextClip — normal text
  // ----------------------------------------------------------------
  test("submitTextClip creates a text clip for normal text", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    await act(async () => result.current.submitTextClip("hello"));

    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
    const args = params.onQueueLocalBinaryClip.mock.calls[0][0];
    expect(args.kind).toBe("text");
  });

  // ----------------------------------------------------------------
  // submitTextClip — session JSON with onImportSessions
  // ----------------------------------------------------------------
  test("submitTextClip detects session import JSON", async () => {
    const sessionJson = JSON.stringify({
      type: "elpasto:sessions",
      version: 1,
      sessions: [{ token: "amber-anchor-apple-arch-arrow" }],
    });
    const onSessionImportDetected = vi.fn();
    const params = makeParams({
      onImportSessions: vi.fn(),
      onSessionImportDetected,
    });
    const { result } = renderHook(() => useActions(params));

    await act(async () => result.current.submitTextClip(sessionJson));

    expect(onSessionImportDetected).toHaveBeenCalled();
    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // addTextClip error — ClipCryptoError
  // ----------------------------------------------------------------
  test("addTextClip surfaces ClipCryptoError message", async () => {
    const params = makeParams();
    params.onQueueLocalBinaryClip.mockRejectedValueOnce(
      new ClipCryptoError("Wrong unlock secret")
    );
    const { result } = renderHook(() => useActions(params));

    await act(async () => result.current.submitTextClip("text"));

    expect(params.setError).toHaveBeenCalledWith("Wrong unlock secret");
  });

  // ----------------------------------------------------------------
  // addTextClip error — generic Error
  // ----------------------------------------------------------------
  test("addTextClip surfaces generic Error message", async () => {
    const params = makeParams();
    params.onQueueLocalBinaryClip.mockRejectedValueOnce(
      new Error("Some error")
    );
    const { result } = renderHook(() => useActions(params));

    await act(async () => result.current.submitTextClip("text"));

    expect(params.setError).toHaveBeenCalledWith("Some error");
  });

  // ----------------------------------------------------------------
  // addTextClip error — non-Error thrown value (fallback message)
  // ----------------------------------------------------------------
  test("addTextClip uses fallback message for non-Error throws", async () => {
    const params = makeParams();
    params.onQueueLocalBinaryClip.mockRejectedValueOnce("string error");
    const { result } = renderHook(() => useActions(params));

    await act(async () => result.current.submitTextClip("text"));

    expect(params.setError).toHaveBeenCalledWith("Failed to add clip");
  });

  // ----------------------------------------------------------------
  // addFileClip error — ClipCryptoError
  // ----------------------------------------------------------------
  test("addFileClip surfaces ClipCryptoError message", async () => {
    const params = makeParams();
    params.onQueueLocalBinaryClip.mockRejectedValueOnce(
      new ClipCryptoError("Encryption failed")
    );
    const { result } = renderHook(() => useActions(params));

    const event = {
      target: { files: [new File(["x"], "x.bin", { type: "application/octet-stream" })], value: "" },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => result.current.handleFileSelect(event));

    expect(params.setError).toHaveBeenCalledWith("Encryption failed");
  });

  // ----------------------------------------------------------------
  // addFileClip error — non-Error thrown value (fallback)
  // ----------------------------------------------------------------
  test("addFileClip uses fallback message for non-Error throws", async () => {
    const params = makeParams();
    params.onQueueLocalBinaryClip.mockRejectedValueOnce(42);
    const { result } = renderHook(() => useActions(params));

    const event = {
      target: { files: [new File(["x"], "x.bin", { type: "application/octet-stream" })], value: "" },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => result.current.handleFileSelect(event));

    expect(params.setError).toHaveBeenCalledWith("Failed to upload");
  });

  // ----------------------------------------------------------------
  // addTextClip with unlockSecret — includes secret in call
  // ----------------------------------------------------------------
  test("addTextClip passes secret when unlockSecret is set", async () => {
    const params = makeParams({ unlockSecret: "my-secret" });
    const { result } = renderHook(() => useActions(params));

    await act(async () => result.current.submitTextClip("encrypted text"));

    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "my-secret" })
    );
  });

  // ----------------------------------------------------------------
  // addFileClip with unlockSecret
  // ----------------------------------------------------------------
  test("addFileClip passes secret when unlockSecret is set", async () => {
    const params = makeParams({ unlockSecret: "my-secret" });
    const { result } = renderHook(() => useActions(params));

    const event = {
      target: { files: [new File(["x"], "x.png", { type: "image/png" })], value: "" },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => result.current.handleFileSelect(event));

    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "my-secret", kind: "image" })
    );
  });

  // ----------------------------------------------------------------
  // addFileClip — non-image file gets kind "file"
  // ----------------------------------------------------------------
  test("addFileClip assigns kind file for non-image files", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = {
      target: { files: [new File(["x"], "doc.pdf", { type: "application/pdf" })], value: "" },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => result.current.handleFileSelect(event));

    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file" })
    );
  });

  // ----------------------------------------------------------------
  // handleFileSelect — no files
  // ----------------------------------------------------------------
  test("handleFileSelect does nothing when no files selected", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = {
      target: { files: null, value: "" },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => result.current.handleFileSelect(event));

    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // clearZone — success
  // ----------------------------------------------------------------
  test("clearZone calls onClearZone and manages isClearing state", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    await act(async () => result.current.clearZone());

    expect(params.setIsClearing).toHaveBeenCalledWith(true);
    expect(params.onClearZone).toHaveBeenCalled();
    expect(params.setIsClearing).toHaveBeenCalledWith(false);
  });

  // ----------------------------------------------------------------
  // clearZone — failure
  // ----------------------------------------------------------------
  test("clearZone sets error on failure", async () => {
    const params = makeParams();
    params.onClearZone.mockRejectedValueOnce(new Error("clear failed"));
    const { result } = renderHook(() => useActions(params));

    await act(async () => result.current.clearZone());

    expect(params.setError).toHaveBeenCalledWith("Failed to clear clips");
    expect(params.setIsClearing).toHaveBeenCalledWith(false);
  });

  // ----------------------------------------------------------------
  // handlePaste — file item with valid file
  // ----------------------------------------------------------------
  test("handlePaste with file item calls addFileClip", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));
    const file = new File(["data"], "test.png", { type: "image/png" });

    const event = {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => file }],
        getData: () => "",
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => result.current.handlePaste(event));

    expect(event.preventDefault).toHaveBeenCalled();
    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
    expect(params.onQueueLocalBinaryClip.mock.calls[0][0].kind).toBe("image");
  });

  // ----------------------------------------------------------------
  // handlePaste — HTML + text
  // ----------------------------------------------------------------
  test("handlePaste with html and text creates html clip", async () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = {
      clipboardData: {
        items: [],
        getData: (type: string) => {
          if (type === "text/html") return "<b>bold</b>";
          if (type === "text/plain") return "bold";
          return "";
        },
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => result.current.handlePaste(event));

    expect(params.onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
    expect(params.onQueueLocalBinaryClip.mock.calls[0][0].kind).toBe("html");
  });

  // ----------------------------------------------------------------
  // handlePaste — no text, no html, no files (nothing to paste)
  // ----------------------------------------------------------------
  test("handlePaste with empty items and no text/html does nothing", () => {
    const params = makeParams();
    const { result } = renderHook(() => useActions(params));

    const event = {
      clipboardData: {
        items: [],
        getData: () => "",
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    act(() => result.current.handlePaste(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(params.onQueueLocalBinaryClip).not.toHaveBeenCalled();
  });
});
