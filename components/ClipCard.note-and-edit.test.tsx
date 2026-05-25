// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Clip } from "@/lib/clips";

// --- Hoisted mocks ----------------------------------------------------------
const {
  copyHtmlMock,
  copyImageBlobMock,
  copyImageFromUrlMock,
  copyTextMock,
  decryptBinaryPayloadMock,
  decryptHtmlPayloadMock,
  decryptTextPayloadMock,
  decryptTextWithHandleMock,
  decryptHtmlWithHandleMock,
  decryptBinaryWithHandleMock,
  updateClipNoteMock,
} = vi.hoisted(() => ({
  copyHtmlMock: vi.fn(),
  copyImageBlobMock: vi.fn(),
  copyImageFromUrlMock: vi.fn(),
  copyTextMock: vi.fn(),
  decryptBinaryPayloadMock: vi.fn(),
  decryptHtmlPayloadMock: vi.fn(),
  decryptTextPayloadMock: vi.fn(),
  decryptTextWithHandleMock: vi.fn(),
  decryptHtmlWithHandleMock: vi.fn(),
  decryptBinaryWithHandleMock: vi.fn(),
  updateClipNoteMock: vi.fn(),
}));

const buildApiUrlMock = vi.fn((path: string) => path);
const fetchMock = vi.fn();
const requestUnlockSecretMock = vi.fn();
const onDeleteMock = vi.fn();
const onUpdateContentMock = vi.fn();

vi.mock("@/lib/api", () => ({ buildApiUrl: buildApiUrlMock }));
vi.mock("@/hooks/useClipboard", () => ({
  copyHtml: copyHtmlMock,
  copyImageBlob: copyImageBlobMock,
  copyImageFromUrl: copyImageFromUrlMock,
  copyText: copyTextMock,
}));
vi.mock("@/lib/clip-crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clip-crypto")>();
  return {
    ...actual,
    decryptBinaryPayload: decryptBinaryPayloadMock,
    decryptHtmlPayload: decryptHtmlPayloadMock,
    decryptTextPayload: decryptTextPayloadMock,
    decryptTextWithHandle: decryptTextWithHandleMock,
    decryptHtmlWithHandle: decryptHtmlWithHandleMock,
    decryptBinaryWithHandle: decryptBinaryWithHandleMock,
  };
});

// Mock updateClipNote so we don't depend on IndexedDB. The real implementation
// is already tested in lib/clip-store tests.
vi.mock("@/lib/clip-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clip-store")>();
  return { ...actual, updateClipNote: updateClipNoteMock };
});

let ClipCard: typeof import("./ClipCard").ClipCard;
let createObjectUrlSpy: ReturnType<typeof vi.spyOn>;
let revokeObjectUrlSpy: ReturnType<typeof vi.spyOn>;
let anchorClickSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  ({ ClipCard } = await import("./ClipCard"));
});

beforeEach(() => {
  vi.clearAllMocks();
  buildApiUrlMock.mockImplementation((path: string) => path);
  copyTextMock.mockResolvedValue(false);
  copyHtmlMock.mockResolvedValue(false);
  copyImageBlobMock.mockResolvedValue(false);
  copyImageFromUrlMock.mockResolvedValue(false);
  requestUnlockSecretMock.mockResolvedValue("secret");
  onUpdateContentMock.mockResolvedValue(undefined);
  updateClipNoteMock.mockResolvedValue(undefined);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  createObjectUrlSpy = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation(() => "blob:test");
  revokeObjectUrlSpy = vi
    .spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => undefined);
  anchorClickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  createObjectUrlSpy.mockRestore();
  revokeObjectUrlSpy.mockRestore();
  anchorClickSpy.mockRestore();
  vi.restoreAllMocks();
});

function buildClip(overrides: Partial<Clip>): Clip {
  return {
    id: 1,
    session_id: 1,
    zone: "A",
    kind: "file",
    client_transfer_id: "transfer-note",
    mime_type: "application/pdf",
    text_content: null,
    html_content: null,
    storage_key: null,
    original_name: "upload.pdf",
    size_bytes: 11,
    encrypted: false,
    encryption_version: null,
    encryption_meta: null,
    created_at: "2026-03-08T10:00:00Z",
    local_only: true,
    local_origin: "sender",
    local_transfer_state: "complete",
    local_file: new File(["hello world"], "upload.pdf", {
      type: "application/pdf",
    }),
    ...overrides,
  };
}

function renderCard(clip: Clip, props: Partial<{
  onUpdateContent?: typeof onUpdateContentMock;
}> = {}) {
  return render(
    <ClipCard
      clip={clip}
      token="session-1"
      expiresAt={new Date(Date.now() + 60_000).toISOString()}
      canCopyImage={true}
      getDirectClipCiphertext={() => null}
      getSendProgress={() => null}
      getTransferStats={() => null}
      readyPeerCount={0}
      unlockSecret={null}
      requestUnlockSecret={requestUnlockSecretMock}
      onDelete={onDeleteMock}
      onUpdateContent={
        props.onUpdateContent === undefined ? onUpdateContentMock : props.onUpdateContent
      }
      subscribeToSendProgress={() => () => undefined}
      subscribeToDirectTransfers={() => () => undefined}
    />,
  );
}

describe("ClipCard sender note editing", () => {
  test("'+ Note' button opens the note input", () => {
    const view = renderCard(buildClip({}));
    fireEvent.click(view.getByText("+ Note"));
    expect(view.getByPlaceholderText(/Add a note/i)).toBeTruthy();
  });

  test("typing in the note input updates the value", () => {
    const view = renderCard(buildClip({}));
    fireEvent.click(view.getByText("+ Note"));
    const input = view.getByPlaceholderText(/Add a note/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "for Carol" } });
    expect(input.value).toBe("for Carol");
  });

  test("Enter key saves the note and calls updateClipNote", async () => {
    const view = renderCard(buildClip({ client_transfer_id: "xfer-42" }));
    fireEvent.click(view.getByText("+ Note"));
    const input = view.getByPlaceholderText(/Add a note/i);
    fireEvent.change(input, { target: { value: "  trimmed note  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(updateClipNoteMock).toHaveBeenCalledWith(
        "xfer-42",
        "session-1",
        "trimmed note",
      ),
    );
    expect(view.queryByPlaceholderText(/Add a note/i)).toBeNull();
  });

  test("blur saves the note", async () => {
    const view = renderCard(buildClip({ client_transfer_id: "xfer-blur" }));
    fireEvent.click(view.getByText("+ Note"));
    const input = view.getByPlaceholderText(/Add a note/i);
    fireEvent.change(input, { target: { value: "blur note" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(updateClipNoteMock).toHaveBeenCalledWith(
        "xfer-blur",
        "session-1",
        "blur note",
      ),
    );
  });

  test("Escape closes the note input without saving and restores prior value", async () => {
    const view = renderCard(buildClip({}));
    fireEvent.click(view.getByText("+ Note"));
    const input = view.getByPlaceholderText(/Add a note/i);
    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(view.queryByPlaceholderText(/Add a note/i)).toBeNull();
    // Wait a tick to ensure no async save fired
    await Promise.resolve();
    expect(updateClipNoteMock).not.toHaveBeenCalled();
  });

  test("saving an empty/whitespace note stores null", async () => {
    const view = renderCard(buildClip({ client_transfer_id: "xfer-null" }));
    fireEvent.click(view.getByText("+ Note"));
    const input = view.getByPlaceholderText(/Add a note/i);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(updateClipNoteMock).toHaveBeenCalledWith(
        "xfer-null",
        "session-1",
        null,
      ),
    );
  });

  test("does not call updateClipNote when client_transfer_id is missing", async () => {
    const view = renderCard(buildClip({ client_transfer_id: null }));
    fireEvent.click(view.getByText("+ Note"));
    const input = view.getByPlaceholderText(/Add a note/i);
    fireEvent.change(input, { target: { value: "note" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Note UI should close
    await waitFor(() =>
      expect(view.queryByPlaceholderText(/Add a note/i)).toBeNull(),
    );
    expect(updateClipNoteMock).not.toHaveBeenCalled();
  });

  test("'+ Note' button disappears after a note is saved", async () => {
    const view = renderCard(buildClip({}));
    fireEvent.click(view.getByText("+ Note"));
    const input = view.getByPlaceholderText(/Add a note/i);
    fireEvent.change(input, { target: { value: "saved" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(updateClipNoteMock).toHaveBeenCalled());
    expect(view.queryByText("+ Note")).toBeNull();
  });
});

describe("ClipCard content edit edge cases", () => {
  test("HTML sender clip with non-JSON localFile falls back to raw text", async () => {
    const view = renderCard(
      buildClip({
        kind: "html",
        mime_type: "text/html",
        original_name: "snippet.html",
        // html_content provides the visible preview surface so we can click it.
        // The localFile content is plain text — not JSON — exercising the
        // JSON.parse-catch fallback in loadCommittedContent.
        html_content: "<p>Click me</p>",
        local_file: new File(["just plain text, not JSON"], "snippet.html", {
          type: "text/html",
        }),
      }),
    );

    fireEvent.click(view.getByText("Click me"));

    const textarea = await view.findByDisplayValue("just plain text, not JSON");
    expect(textarea).toBeTruthy();
  });

  test("text sender clip without local_file uses decryptedText fallback path", async () => {
    // local_file is null but text_content is present — exercises the
    // `decryptedText ?? clip.text_content ?? ""` branch in loadCommittedContent.
    const view = renderCard(
      buildClip({
        kind: "text",
        mime_type: "text/plain",
        original_name: null,
        local_file: null,
        text_content: "inline text",
      }),
    );

    fireEvent.click(view.getByText("inline text"));
    const textarea = await view.findByDisplayValue("inline text");
    expect(textarea).toBeTruthy();
  });

  test("saving content with no changes skips onUpdateContent", async () => {
    const view = renderCard(
      buildClip({
        kind: "text",
        mime_type: "text/plain",
        local_file: new File(["unchanged"], "clip.txt", { type: "text/plain" }),
        text_content: null,
      }),
    );

    // Initial state shows "Loading text..." until file reads in edit mode.
    fireEvent.click(view.getByText("Loading text..."));
    const textarea = await view.findByDisplayValue("unchanged");
    // Don't change the value, just blur — saveContent should hit the
    // early-return when draftContent === editingBaseline.
    fireEvent.blur(textarea);

    await waitFor(() => expect(view.queryByDisplayValue("unchanged")).toBeNull());
    expect(onUpdateContentMock).not.toHaveBeenCalled();
  });

  test("non-Error rejections from onUpdateContent surface as 'Save failed'", async () => {
    onUpdateContentMock.mockRejectedValueOnce("boom"); // not an Error instance

    const view = renderCard(
      buildClip({
        kind: "text",
        mime_type: "text/plain",
        local_file: new File(["original"], "clip.txt", { type: "text/plain" }),
        text_content: null,
      }),
    );

    fireEvent.click(view.getByText("Loading text..."));
    const textarea = await view.findByDisplayValue("original");
    fireEvent.change(textarea, { target: { value: "next" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain("Save failed"),
    );
  });

  test("Error-instance rejections surface their message", async () => {
    onUpdateContentMock.mockRejectedValueOnce(new Error("network exploded"));

    const view = renderCard(
      buildClip({
        kind: "text",
        mime_type: "text/plain",
        local_file: new File(["original"], "clip.txt", { type: "text/plain" }),
        text_content: null,
      }),
    );

    fireEvent.click(view.getByText("Loading text..."));
    const textarea = await view.findByDisplayValue("original");
    fireEvent.change(textarea, { target: { value: "next" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain("network exploded"),
    );
  });
});
