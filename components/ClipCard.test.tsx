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
import {
  ClipCryptoError,
  WrongUnlockSecretError,
} from "@/lib/clip-crypto";
import type { TransferStats } from "@/lib/direct-transfer";

const buildApiUrlMock = vi.fn((path: string) => path);
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
} = vi.hoisted(() => {
  const decryptBinaryPayloadMock = vi.fn();
  const decryptHtmlPayloadMock = vi.fn();
  const decryptTextPayloadMock = vi.fn();
  // Unified dispatch mocks delegate to the v1 payload mocks by default.
  const decryptTextWithHandleMock = vi.fn(
    (handle: { mode: string; secret?: string }, ciphertext: string, meta: unknown) =>
      decryptTextPayloadMock(
        handle.mode === "normal" ? handle.secret : "__paranoid__",
        ciphertext,
        meta
      )
  );
  const decryptHtmlWithHandleMock = vi.fn(
    (handle: { mode: string; secret?: string }, ciphertext: string, meta: unknown) =>
      decryptHtmlPayloadMock(
        handle.mode === "normal" ? handle.secret : "__paranoid__",
        ciphertext,
        meta
      )
  );
  const decryptBinaryWithHandleMock = vi.fn(
    (handle: { mode: string; secret?: string }, ciphertext: unknown, meta: unknown) =>
      decryptBinaryPayloadMock(
        handle.mode === "normal" ? handle.secret : "__paranoid__",
        ciphertext,
        meta
      )
  );
  return {
    copyHtmlMock: vi.fn(),
    copyImageBlobMock: vi.fn(),
    copyImageFromUrlMock: vi.fn(),
    copyTextMock: vi.fn(),
    decryptBinaryPayloadMock,
    decryptHtmlPayloadMock,
    decryptTextPayloadMock,
    decryptTextWithHandleMock,
    decryptHtmlWithHandleMock,
    decryptBinaryWithHandleMock,
  };
});
const requestUnlockSecretMock = vi.fn();
const onDeleteMock = vi.fn();
const fetchMock = vi.fn();
const createObjectURLMock = vi.fn(() => "blob:test");
const revokeObjectURLMock = vi.fn();
const anchorClickMock = vi.fn();

vi.mock("@/lib/api", () => ({
  buildApiUrl: buildApiUrlMock,
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

vi.mock("@/hooks/useClipboard", () => ({
  copyHtml: copyHtmlMock,
  copyImageBlob: copyImageBlobMock,
  copyImageFromUrl: copyImageFromUrlMock,
  copyText: copyTextMock,
}));

let ClipCard: typeof import("./ClipCard").ClipCard;

beforeAll(async () => {
  ({ ClipCard } = await import("./ClipCard"));
});

beforeEach(() => {
  buildApiUrlMock.mockReset();
  buildApiUrlMock.mockImplementation((path: string) => path);
  copyHtmlMock.mockReset();
  copyImageBlobMock.mockReset();
  copyImageFromUrlMock.mockReset();
  copyTextMock.mockReset();
  decryptBinaryPayloadMock.mockReset();
  decryptHtmlPayloadMock.mockReset();
  decryptTextPayloadMock.mockReset();
  requestUnlockSecretMock.mockReset();
  requestUnlockSecretMock.mockResolvedValue("secret");
  onDeleteMock.mockReset();
  fetchMock.mockReset();
  createObjectURLMock.mockClear();
  revokeObjectURLMock.mockClear();
  anchorClickMock.mockClear();
  copyHtmlMock.mockResolvedValue(false);
  copyImageBlobMock.mockResolvedValue(false);
  copyImageFromUrlMock.mockResolvedValue(false);
  copyTextMock.mockResolvedValue(false);
  decryptBinaryPayloadMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
  decryptHtmlPayloadMock.mockResolvedValue(JSON.stringify({ text: "plain", html: "<p>plain</p>" }));
  decryptTextPayloadMock.mockResolvedValue("decrypted text");
  // Reset unified dispatch mocks to re-apply their default delegate implementations.
  decryptTextWithHandleMock.mockReset();
  decryptTextWithHandleMock.mockImplementation(
    (handle: { mode: string; secret?: string }, ciphertext: string, meta: unknown) =>
      decryptTextPayloadMock(
        handle.mode === "normal" ? handle.secret : "__paranoid__",
        ciphertext,
        meta
      )
  );
  decryptHtmlWithHandleMock.mockReset();
  decryptHtmlWithHandleMock.mockImplementation(
    (handle: { mode: string; secret?: string }, ciphertext: string, meta: unknown) =>
      decryptHtmlPayloadMock(
        handle.mode === "normal" ? handle.secret : "__paranoid__",
        ciphertext,
        meta
      )
  );
  decryptBinaryWithHandleMock.mockReset();
  decryptBinaryWithHandleMock.mockImplementation(
    (handle: { mode: string; secret?: string }, ciphertext: unknown, meta: unknown) =>
      decryptBinaryPayloadMock(
        handle.mode === "normal" ? handle.secret : "__paranoid__",
        ciphertext,
        meta
      )
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  Object.defineProperty(globalThis.URL, "createObjectURL", {
    configurable: true,
    value: createObjectURLMock,
  });
  Object.defineProperty(globalThis.URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURLMock,
  });
  HTMLAnchorElement.prototype.click = anchorClickMock;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCard(
  clip: Clip,
  {
    getDirectClipCiphertext = () => null,
    getSendProgress = () => null,
    getTransferStats = () => null,
    readyPeerCount = 0,
  }: {
    getDirectClipCiphertext?: (clipId: number) => Uint8Array | null;
    getSendProgress?: (transferId: string) => number | null;
    getTransferStats?: (transferId: string) => TransferStats | null;
    readyPeerCount?: number;
  } = {}
) {
  return render(
    <ClipCard
      clip={clip}
      token="session-1"
      expiresAt={new Date(Date.now() + 60_000).toISOString()}
      canCopyImage={true}
      getDirectClipCiphertext={getDirectClipCiphertext}
      getSendProgress={getSendProgress}
      getTransferStats={getTransferStats}
      readyPeerCount={readyPeerCount}
      unlockSecret={null}
      requestUnlockSecret={requestUnlockSecretMock}
      onDelete={onDeleteMock}
      subscribeToSendProgress={() => () => undefined}
      subscribeToDirectTransfers={() => () => undefined}
    />
  );
}

describe("ClipCard", () => {
  test("deletes sender-local files without hitting the API", () => {
    const clip = {
      id: -1,
      session_id: 0,
      zone: "A",
      kind: "file",
      client_transfer_id: "transfer-1",
      mime_type: "application/pdf",
      text_content: null,
      html_content: null,
      storage_key: null,
      original_name: "local.pdf",
      size_bytes: 12,
      encrypted: false,
      encryption_version: null,
      encryption_meta: null,
      created_at: "2026-03-08T10:00:00Z",
      local_only: true,
      local_origin: "sender",
      local_transfer_state: "complete",
      local_file: new File(["hello world"], "local.pdf", { type: "application/pdf" }),
    } satisfies Clip;

    const view = renderCard(clip);
    fireEvent.click(view.getByText("Delete"));

    expect(onDeleteMock).toHaveBeenCalledWith(clip);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.getByText(/local only/)).toBeTruthy();
  });

  test("shows a waiting state for receiver-local transfers that are still pending", () => {
    const clip = {
      id: -2,
      session_id: 0,
      zone: "A",
      kind: "file",
      client_transfer_id: "transfer-2",
      mime_type: "application/pdf",
      text_content: null,
      html_content: null,
      storage_key: null,
      original_name: "remote.pdf",
      size_bytes: 12,
      encrypted: true,
      encryption_version: 1,
      encryption_meta: {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: "salt",
        iv: "iv",
        payload: "binary",
      },
      created_at: "2026-03-08T10:00:00Z",
      local_only: true,
      local_origin: "receiver",
      local_transfer_state: "pending",
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);

    expect(view.getByText("Waiting for a peer that has this clip to connect...")).toBeTruthy();
    expect(view.getByText("Decrypt & Download").getAttribute("disabled")).not.toBeNull();
  });

  test("shows sender progress for local sender files", () => {
    const clip = {
      id: -4,
      session_id: 0,
      zone: "A",
      kind: "file",
      client_transfer_id: "transfer-4",
      mime_type: "application/pdf",
      text_content: null,
      html_content: null,
      storage_key: null,
      original_name: "upload.pdf",
      size_bytes: 12,
      encrypted: false,
      encryption_version: null,
      encryption_meta: null,
      created_at: "2026-03-08T10:00:00Z",
      local_only: true,
      local_origin: "sender",
      local_transfer_state: "complete",
      local_file: new File(["hello world"], "upload.pdf", { type: "application/pdf" }),
    } satisfies Clip;

    const view = renderCard(clip, {
      getSendProgress: () => 0.73,
    });

    expect(view.getByText("Sending...")).toBeTruthy();
    expect(view.getByText("73%")).toBeTruthy();
  });

  test("renders receiver-local unencrypted direct-transfer images as previews", async () => {
    const ciphertext = new Uint8Array([1, 2, 3, 4]);
    const clip = {
      id: -44,
      session_id: 0,
      zone: "B",
      kind: "image",
      client_transfer_id: "transfer-image-1",
      mime_type: "image/jpeg",
      text_content: null,
      html_content: null,
      storage_key: null,
      original_name: "photo.jpg",
      size_bytes: 1024,
      encrypted: false,
      encryption_version: null,
      encryption_meta: null,
      created_at: "2026-03-08T10:00:00Z",
      local_only: true,
      local_origin: "receiver",
      local_transfer_state: "complete",
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip, {
      getDirectClipCiphertext: (clipId) =>
        clipId === clip.id ? ciphertext : null,
    });

    await waitFor(() => expect(createObjectURLMock).toHaveBeenCalledTimes(1));
    expect(view.getByAltText("photo.jpg").getAttribute("src")).toBe("blob:test");
  });

  test("sanitizes rich HTML previews before rendering them", () => {
    const clip = {
      id: 9,
      session_id: 1,
      zone: "A",
      kind: "html",
      client_transfer_id: null,
      mime_type: "text/html",
      text_content: "hello world",
      html_content:
        '<p>Hello <a href="javascript:alert(1)" onclick="steal()">world</a><script>alert(1)</script></p>',
      storage_key: null,
      original_name: null,
      size_bytes: 12,
      encrypted: false,
      encryption_version: null,
      encryption_meta: null,
      created_at: "2026-03-08T10:00:00Z",
      local_only: false,
      local_origin: null,
      local_transfer_state: null,
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);
    const preview = view.container.querySelector(".prose");

    expect(preview?.innerHTML).toContain("<p>Hello <a>world</a></p>");
    expect(preview?.innerHTML).not.toContain("script");
    expect(preview?.innerHTML).not.toContain("onclick");
    expect(preview?.innerHTML).not.toContain("javascript:");
  });

  test("shows receiver byte and speed stats while a direct transfer is active", () => {
    const clip = {
      id: -5,
      session_id: 0,
      zone: "A",
      kind: "file",
      client_transfer_id: "transfer-5",
      mime_type: "application/pdf",
      text_content: null,
      html_content: null,
      storage_key: null,
      original_name: "remote.pdf",
      size_bytes: 12,
      encrypted: true,
      encryption_version: 1,
      encryption_meta: {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: "salt",
        iv: "iv",
        payload: "binary",
      },
      created_at: "2026-03-08T10:00:00Z",
      local_only: true,
      local_origin: "receiver",
      local_transfer_state: "pending",
      local_file: null,
    } satisfies Clip;

    const stats = {
      progress: 0.33,
      bytesReceived: 4.2 * 1024 * 1024,
      totalBytes: 12.8 * 1024 * 1024,
      speedBps: 1.3 * 1024 * 1024,
    } satisfies TransferStats;

    const view = renderCard(clip, {
      readyPeerCount: 1,
      getTransferStats: () => stats,
    });

    expect(view.getByText(/Receiving\.\.\. 4.2 MB \/ 12.8 MB/)).toBeTruthy();
    expect(view.getByText("1.3 MB/s · 33%")).toBeTruthy();
    expect(view.getByText("Transferring directly from sender...")).toBeTruthy();
  });

  test("shows a failed state when a direct transfer times out after starting", () => {
    const clip = {
      id: -3,
      session_id: 0,
      zone: "A",
      kind: "file",
      client_transfer_id: "transfer-3",
      mime_type: "application/pdf",
      text_content: null,
      html_content: null,
      storage_key: null,
      original_name: "remote.pdf",
      size_bytes: 12,
      encrypted: true,
      encryption_version: 1,
      encryption_meta: {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: "salt",
        iv: "iv",
        payload: "binary",
      },
      created_at: "2026-03-08T10:00:00Z",
      local_only: true,
      local_origin: "receiver",
      local_transfer_state: "failed",
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);

    expect(view.getByText("Direct transfer stalled before completion. Ask the sender to retry.")).toBeTruthy();
  });

  test("shows a decrypt error when copying encrypted text with the wrong secret", async () => {
    decryptTextPayloadMock.mockRejectedValueOnce(new WrongUnlockSecretError("Wrong unlock secret"));

    const clip = {
      id: 11,
      session_id: 1,
      zone: "A",
      kind: "text",
      client_transfer_id: null,
      mime_type: "text/plain",
      text_content: "ciphertext",
      html_content: null,
      storage_key: null,
      original_name: null,
      size_bytes: 12,
      encrypted: true,
      encryption_version: 1,
      encryption_meta: {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: "salt",
        iv: "iv",
        payload: "text",
      },
      created_at: "2026-03-08T10:00:00Z",
      local_only: false,
      local_origin: null,
      local_transfer_state: null,
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);
    fireEvent.click(view.getByText("Copy"));

    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Wrong unlock secret"));
    expect(requestUnlockSecretMock).toHaveBeenCalledTimes(1);
    expect(copyTextMock).not.toHaveBeenCalled();
  });

  test("does not attempt decrypt or copy when the unlock prompt is canceled", async () => {
    requestUnlockSecretMock.mockResolvedValueOnce(null);

    const clip = {
      id: 12,
      session_id: 1,
      zone: "A",
      kind: "text",
      client_transfer_id: null,
      mime_type: "text/plain",
      text_content: "ciphertext",
      html_content: null,
      storage_key: null,
      original_name: null,
      size_bytes: 12,
      encrypted: true,
      encryption_version: 1,
      encryption_meta: {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: "salt",
        iv: "iv",
        payload: "text",
      },
      created_at: "2026-03-08T10:00:00Z",
      local_only: false,
      local_origin: null,
      local_transfer_state: null,
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);
    fireEvent.click(view.getByText("Copy"));

    await waitFor(() => expect(requestUnlockSecretMock).toHaveBeenCalledTimes(1));
    expect(decryptTextPayloadMock).not.toHaveBeenCalled();
    expect(copyTextMock).not.toHaveBeenCalled();
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("deletes text clips through the shared local delete handler", () => {
    const clip = {
      id: 13,
      session_id: 1,
      zone: "A",
      kind: "text",
      client_transfer_id: null,
      mime_type: "text/plain",
      text_content: "hello",
      html_content: null,
      storage_key: null,
      original_name: null,
      size_bytes: 5,
      encrypted: false,
      encryption_version: null,
      encryption_meta: null,
      created_at: "2026-03-08T10:00:00Z",
      local_only: false,
      local_origin: null,
      local_transfer_state: null,
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);
    fireEvent.click(view.getByText("Delete"));

    expect(onDeleteMock).toHaveBeenCalledWith(clip);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("decrypts encrypted remote files before downloading them", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
    });

    const clip = {
      id: 14,
      session_id: 1,
      zone: "A",
      kind: "file",
      client_transfer_id: null,
      mime_type: "application/pdf",
      text_content: null,
      html_content: null,
      storage_key: "stored-secret.pdf",
      original_name: "secret.pdf",
      size_bytes: 12,
      encrypted: true,
      encryption_version: 1,
      encryption_meta: {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: "salt",
        iv: "iv",
        payload: "binary",
      },
      created_at: "2026-03-08T10:00:00Z",
      local_only: false,
      local_origin: null,
      local_transfer_state: null,
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);
    fireEvent.click(view.getByText("Decrypt & Download"));

    await waitFor(() => expect(decryptBinaryPayloadMock).toHaveBeenCalledTimes(1));
    expect(requestUnlockSecretMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/files/session-1/14", { cache: "no-store" });
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(anchorClickMock).toHaveBeenCalledTimes(1);
  });

  test("shows crypto errors from encrypted downloads", async () => {
    decryptBinaryPayloadMock.mockRejectedValueOnce(new ClipCryptoError("Failed to decrypt clip"));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
    });

    const clip = {
      id: 15,
      session_id: 1,
      zone: "A",
      kind: "file",
      client_transfer_id: null,
      mime_type: "application/pdf",
      text_content: null,
      html_content: null,
      storage_key: "stored-secret.pdf",
      original_name: "secret.pdf",
      size_bytes: 12,
      encrypted: true,
      encryption_version: 1,
      encryption_meta: {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: "salt",
        iv: "iv",
        payload: "binary",
      },
      created_at: "2026-03-08T10:00:00Z",
      local_only: false,
      local_origin: null,
      local_transfer_state: null,
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);
    fireEvent.click(view.getByText("Decrypt & Download"));

    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Failed to decrypt clip"));
    expect(anchorClickMock).not.toHaveBeenCalled();
  });

  test("shows shield icon for v2 encrypted clips instead of lock icon", () => {
    const clip = {
      id: 50,
      session_id: 1,
      zone: "A",
      kind: "text",
      client_transfer_id: null,
      mime_type: "text/plain",
      text_content: "ciphertext",
      html_content: null,
      storage_key: null,
      original_name: null,
      size_bytes: 12,
      encrypted: true,
      encryption_version: 2,
      encryption_meta: {
        v: 2,
        kdf: "HKDF-SHA256",
        salt: "salt",
        iv: "iv",
        payload: "text",
      },
      created_at: "2026-03-08T10:00:00Z",
      local_only: false,
      local_origin: null,
      local_transfer_state: null,
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);

    // Shield icon should be present for v2
    const shield = view.container.querySelector('[aria-label="Paranoid encryption"]');
    expect(shield).toBeTruthy();
    // Lock icon should NOT be present
    const lock = view.container.querySelector('[aria-label="Encrypted"]');
    expect(lock).toBeNull();
  });

  test("shows lock icon for v1 encrypted clips", () => {
    const clip = {
      id: 51,
      session_id: 1,
      zone: "A",
      kind: "text",
      client_transfer_id: null,
      mime_type: "text/plain",
      text_content: "ciphertext",
      html_content: null,
      storage_key: null,
      original_name: null,
      size_bytes: 12,
      encrypted: true,
      encryption_version: 1,
      encryption_meta: {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: "salt",
        iv: "iv",
        payload: "text",
      },
      created_at: "2026-03-08T10:00:00Z",
      local_only: false,
      local_origin: null,
      local_transfer_state: null,
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);

    // Lock icon should be present for v1
    const lock = view.container.querySelector('[aria-label="Encrypted"]');
    expect(lock).toBeTruthy();
    // Shield should NOT be present
    const shield = view.container.querySelector('[aria-label="Paranoid encryption"]');
    expect(shield).toBeNull();
  });

  test("preserves safe preview attributes while stripping unsafe HTML attributes", () => {
    const clip = {
      id: 10,
      session_id: 1,
      zone: "A",
      kind: "html",
      client_transfer_id: null,
      mime_type: "text/html",
      text_content: "table text",
      html_content:
        '<table><tr><td colspan="2" rowspan="0" onclick="steal()">Cell</td></tr></table>' +
        '<a href="https://example.test?q=1&x=<tag>" title=\'"hello"<world>\' target="_blank" rel="nofollow">link</a>' +
        '<a href="data:text/html,boom">bad</a>',
      storage_key: null,
      original_name: null,
      size_bytes: 12,
      encrypted: false,
      encryption_version: null,
      encryption_meta: null,
      created_at: "2026-03-08T10:00:00Z",
      local_only: false,
      local_origin: null,
      local_transfer_state: null,
      local_file: null,
    } satisfies Clip;

    const view = renderCard(clip);
    const preview = view.container.querySelector(".prose");

    expect(preview?.innerHTML).toContain('<td colspan="2">Cell</td>');
    expect(preview?.innerHTML).toContain('<a href="https://example.test?q=1&amp;x="');
    expect(preview?.innerHTML).toContain('title="&quot;hello&quot;"');
    expect(preview?.innerHTML).toContain('target="_blank"');
    expect(preview?.innerHTML).toContain("<a>bad</a>");
    expect(preview?.innerHTML).not.toContain("rowspan");
    expect(preview?.innerHTML).not.toContain("onclick");
    expect(preview?.innerHTML).not.toContain("data:text/html");
  });
});
