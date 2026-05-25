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
import type { TransferStats } from "@/lib/direct-transfer";

const buildApiUrlMock = vi.fn((path: string) => `https://api.example.test${path}`);
const copyHtmlMock = vi.fn();
const copyImageBlobMock = vi.fn();
const copyImageFromUrlMock = vi.fn();
const copyTextMock = vi.fn();
const decryptBinaryPayloadMock = vi.fn();
const decryptHtmlPayloadMock = vi.fn();
const decryptTextPayloadMock = vi.fn();
const decryptTextWithHandleMock = vi.fn();
const decryptHtmlWithHandleMock = vi.fn();
const decryptBinaryWithHandleMock = vi.fn();
const fetchMock = vi.fn();
const requestUnlockSecretMock = vi.fn();
const onDeleteMock = vi.fn();
const onUpdateContentMock = vi.fn();

vi.mock("@/lib/api", () => ({
  buildApiUrl: buildApiUrlMock,
}));

vi.mock("@/hooks/useClipboard", () => ({
  copyHtml: copyHtmlMock,
  copyImageBlob: copyImageBlobMock,
  copyImageFromUrl: copyImageFromUrlMock,
  copyText: copyTextMock,
}));

vi.mock("@/lib/clip-crypto", () => {
  class ClipCryptoError extends Error {}
  class WrongUnlockSecretError extends ClipCryptoError {}

  return {
    ClipCryptoError,
    WrongUnlockSecretError,
    decryptBinaryPayload: decryptBinaryPayloadMock,
    decryptHtmlPayload: decryptHtmlPayloadMock,
    decryptTextPayload: decryptTextPayloadMock,
    decryptTextWithHandle: decryptTextWithHandleMock,
    decryptHtmlWithHandle: decryptHtmlWithHandleMock,
    decryptBinaryWithHandle: decryptBinaryWithHandleMock,
    toArrayBuffer: (bytes: Uint8Array) =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
});

let ClipCard: typeof import("./ClipCard").ClipCard;
let WrongUnlockSecretError: typeof import("@/lib/clip-crypto").WrongUnlockSecretError;
let createObjectUrlSpy: ReturnType<typeof vi.spyOn>;
let revokeObjectUrlSpy: ReturnType<typeof vi.spyOn>;
let anchorClickSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  ({ ClipCard } = await import("./ClipCard"));
  ({ WrongUnlockSecretError } = await import("@/lib/clip-crypto"));
});

beforeEach(() => {
  buildApiUrlMock.mockReset();
  buildApiUrlMock.mockImplementation((path: string) => `https://api.example.test${path}`);
  copyHtmlMock.mockReset();
  copyImageBlobMock.mockReset();
  copyImageFromUrlMock.mockReset();
  copyTextMock.mockReset();
  decryptBinaryPayloadMock.mockReset();
  decryptHtmlPayloadMock.mockReset();
  decryptTextPayloadMock.mockReset();
  // Unified dispatch mocks delegate to the v1 payload mocks by default.
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
  fetchMock.mockReset();
  requestUnlockSecretMock.mockReset();
  requestUnlockSecretMock.mockResolvedValue("unlock-secret");
  onDeleteMock.mockReset();
  onUpdateContentMock.mockReset();
  onUpdateContentMock.mockResolvedValue(undefined);

  globalThis.fetch = fetchMock as unknown as typeof fetch;

  createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:download");
  revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
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
    kind: "text",
    client_transfer_id: null,
    mime_type: "text/plain",
    text_content: "hello world",
    html_content: null,
    storage_key: null,
    original_name: null,
    size_bytes: 11,
    encrypted: false,
    encryption_version: null,
    encryption_meta: null,
    created_at: "2026-03-08T10:00:00Z",
    local_only: false,
    local_origin: null,
    local_transfer_state: null,
    local_file: null,
    ...overrides,
  };
}

function renderCard(
  clip: Clip,
  {
    directCiphertext = null,
    getSendProgress = () => null,
    getTransferStats = () => null,
    readyPeerCount = 0,
    unlockSecret = null,
  }: {
    directCiphertext?: Uint8Array | null;
    getSendProgress?: (transferId: string) => number | null;
    getTransferStats?: (transferId: string) => TransferStats | null;
    readyPeerCount?: number;
    unlockSecret?: string | null;
  } = {}
) {
  return render(
    <ClipCard
      clip={clip}
      token="session-1"
      expiresAt={new Date(Date.now() + 60_000).toISOString()}
      canCopyImage={true}
      getDirectClipCiphertext={() => directCiphertext}
      getSendProgress={getSendProgress}
      getTransferStats={getTransferStats}
      readyPeerCount={readyPeerCount}
      unlockSecret={unlockSecret}
      requestUnlockSecret={requestUnlockSecretMock}
      onDelete={onDeleteMock}
      onUpdateContent={onUpdateContentMock}
      subscribeToSendProgress={() => () => undefined}
      subscribeToDirectTransfers={() => () => undefined}
    />
  );
}

describe("ClipCard actions", () => {
  test("copies plaintext text clips", async () => {
    copyTextMock.mockResolvedValue(true);

    const view = renderCard(buildClip({ text_content: "plain text" }));
    fireEvent.click(view.getByText("Copy"));

    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith("plain text"));
    expect(view.getByText("Copied!")).toBeTruthy();
  });

  test("requests the unlock secret and copies encrypted text clips", async () => {
    copyTextMock.mockResolvedValue(true);
    decryptTextPayloadMock.mockResolvedValue("decrypted text");
    const clip = buildClip({
      kind: "text",
      encrypted: true,
      text_content: "ciphertext",
      encryption_version: 1,
      encryption_meta: {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: "salt",
        iv: "iv",
        payload: "text",
      },
    });

    const view = renderCard(clip);
    fireEvent.click(view.getByText("Copy"));

    await waitFor(() => expect(requestUnlockSecretMock).toHaveBeenCalled());
    expect(decryptTextPayloadMock).toHaveBeenCalledWith(
      "unlock-secret",
      "ciphertext",
      clip.encryption_meta
    );
    expect(copyTextMock).toHaveBeenCalledWith("decrypted text");
  });

  test("renders decrypted encrypted HTML previews and reuses them for copy", async () => {
    decryptHtmlPayloadMock.mockResolvedValue(
      JSON.stringify({
        text: "hello world",
        html: "<p><strong>Hello</strong> world</p>",
      })
    );
    copyHtmlMock.mockResolvedValue("rich");
    const clip = buildClip({
      kind: "html",
      mime_type: "text/html",
      text_content: "ciphertext",
      encrypted: true,
      encryption_version: 1,
      encryption_meta: {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: "salt",
        iv: "iv",
        payload: "html",
      },
    });

    const view = renderCard(clip, { unlockSecret: "unlock-secret" });

    await waitFor(() => {
      const preview = view.container.querySelector(".prose");
      expect(preview?.innerHTML).toContain("<strong>Hello</strong> world");
    });

    fireEvent.click(view.getByText("Copy"));

    await waitFor(() =>
      expect(copyHtmlMock).toHaveBeenCalledWith(
        "<p><strong>Hello</strong> world</p>",
        "hello world"
      )
    );
    expect(decryptHtmlPayloadMock).toHaveBeenCalledTimes(1);
    expect(view.getByText("Copied rich text")).toBeTruthy();
  });

  test("downloads encrypted direct-transfer files after decrypting them in-browser", async () => {
    decryptBinaryPayloadMock.mockResolvedValue(new Uint8Array([7, 8, 9]));
    const clip = buildClip({
      kind: "file",
      mime_type: "application/pdf",
      original_name: "secret.pdf",
      size_bytes: 3,
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
      client_transfer_id: "transfer-1",
      local_only: true,
      local_origin: "receiver",
      local_transfer_state: "complete",
    });

    const view = renderCard(clip, {
      directCiphertext: new Uint8Array([1, 2, 3]),
    });
    fireEvent.click(view.getByText("Decrypt & Download"));

    await waitFor(() =>
      expect(decryptBinaryPayloadMock).toHaveBeenCalledWith(
        "unlock-secret",
        new Uint8Array([1, 2, 3]),
        clip.encryption_meta
      )
    );
    expect(createObjectUrlSpy).toHaveBeenCalled();
    expect(anchorClickSpy).toHaveBeenCalled();
  });

  test("downloads unencrypted direct-transfer files without decrypting them", async () => {
    const clip = buildClip({
      kind: "file",
      mime_type: "application/pdf",
      original_name: "plain.pdf",
      size_bytes: 3,
      client_transfer_id: "transfer-plain",
      local_only: true,
      local_origin: "receiver",
      local_transfer_state: "complete",
    });

    const view = renderCard(clip, {
      directCiphertext: new Uint8Array([4, 5, 6]),
    });
    fireEvent.click(view.getAllByText("Download")[0]);

    await waitFor(() => expect(anchorClickSpy).toHaveBeenCalled());
    expect(decryptBinaryPayloadMock).not.toHaveBeenCalled();
    expect(createObjectUrlSpy).toHaveBeenCalled();
  });

  test("sender text clips enter edit mode and save on blur", async () => {
    const view = renderCard(buildClip({
      local_only: true,
      local_origin: "sender",
      client_transfer_id: "transfer-edit",
      local_file: new File(["original text"], "clip.txt", { type: "text/plain" }),
      text_content: null,
    }));

    fireEvent.click(view.getByText("Loading text..."));

    const textarea = await view.findByDisplayValue("original text");
    fireEvent.change(textarea, { target: { value: "updated text" } });
    fireEvent.blur(textarea);

    await waitFor(() => expect(onUpdateContentMock).toHaveBeenCalledWith({
      transferId: "transfer-edit",
      kind: "text",
      text: "updated text",
    }));
  });

  test("sender text clips save on ctrl+enter", async () => {
    const view = renderCard(buildClip({
      local_only: true,
      local_origin: "sender",
      client_transfer_id: "transfer-edit",
      local_file: new File(["original text"], "clip.txt", { type: "text/plain" }),
      text_content: null,
    }));

    fireEvent.click(view.getByText("Loading text..."));

    const textarea = await view.findByDisplayValue("original text");
    fireEvent.change(textarea, { target: { value: "ctrl enter text" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(onUpdateContentMock).toHaveBeenCalledWith({
      transferId: "transfer-edit",
      kind: "text",
      text: "ctrl enter text",
    }));
  });

  test("escape cancels sender text clip edits", async () => {
    const view = renderCard(buildClip({
      local_only: true,
      local_origin: "sender",
      client_transfer_id: "transfer-edit",
      local_file: new File(["original text"], "clip.txt", { type: "text/plain" }),
      text_content: null,
    }));

    fireEvent.click(view.getByText("Loading text..."));

    const textarea = await view.findByDisplayValue("original text");
    fireEvent.change(textarea, { target: { value: "updated text" } });
    fireEvent.keyDown(textarea, { key: "Escape" });

    await waitFor(() => expect(onUpdateContentMock).not.toHaveBeenCalled());
    expect(view.queryByDisplayValue("updated text")).toBeNull();
  });

  test("encrypted sender text clip without a secret cannot enter edit mode", async () => {
    const view = renderCard(buildClip({
      local_only: true,
      local_origin: "sender",
      client_transfer_id: "transfer-edit",
      local_file: new File(["secret text"], "clip.txt", { type: "text/plain" }),
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
      text_content: null,
    }));

    fireEvent.click(view.getByText("Locked text clip"));

    expect(view.queryByRole("textbox")).toBeNull();
    expect(onUpdateContentMock).not.toHaveBeenCalled();
  });

  test("sender html clips save plain-text edits as html updates", async () => {
    const view = renderCard(buildClip({
      kind: "html",
      mime_type: "application/json",
      local_only: true,
      local_origin: "sender",
      client_transfer_id: "transfer-html",
      local_file: new File(
        [JSON.stringify({ text: "hello world", html: "<p><strong>Hello</strong> world</p>" })],
        "clip.json",
        { type: "application/json" }
      ),
      text_content: null,
      html_content: null,
    }));

    fireEvent.click(await view.findByText("Hello", { exact: false }));

    const textarea = await view.findByDisplayValue("hello world");
    fireEvent.change(textarea, { target: { value: "flattened text" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => expect(onUpdateContentMock).toHaveBeenCalledWith({
      transferId: "transfer-html",
      kind: "html",
      text: "flattened text",
    }));
  });

  test("surfaces wrong unlock secret errors from encrypted downloads", async () => {
    decryptBinaryPayloadMock.mockRejectedValue(new WrongUnlockSecretError("Wrong unlock secret"));
    const clip = buildClip({
      kind: "file",
      mime_type: "application/pdf",
      original_name: "secret.pdf",
      size_bytes: 3,
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
      client_transfer_id: "transfer-2",
      local_only: true,
      local_origin: "receiver",
      local_transfer_state: "complete",
    });

    const view = renderCard(clip, {
      directCiphertext: new Uint8Array([4, 5, 6]),
    });
    fireEvent.click(view.getByText("Decrypt & Download"));

    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Wrong unlock secret"));
  });

  test("routes delete actions through the shared local handler", () => {
    const view = renderCard(buildClip({ id: 42 }));
    fireEvent.click(view.getByText("Delete"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onDeleteMock).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("copies unencrypted remote images from their URL", async () => {
    copyImageFromUrlMock.mockResolvedValue(true);
    const clip = buildClip({
      kind: "image",
      mime_type: "image/png",
      original_name: "photo.png",
      storage_key: "file-key",
    });

    const view = renderCard(clip);
    fireEvent.click(view.getByText("Copy"));

    await waitFor(() =>
      expect(copyImageFromUrlMock).toHaveBeenCalledWith(
        "https://api.example.test/api/files/session-1/1"
      )
    );
    expect(view.getByText("Copied!")).toBeTruthy();
  });

  test("creates and revokes object URLs for local image previews", async () => {
    createObjectUrlSpy
      .mockImplementationOnce(() => "blob:local-image");

    const imageClip = buildClip({
      kind: "image",
      mime_type: "image/png",
      original_name: "preview.png",
      local_only: true,
      local_origin: "sender",
      local_transfer_state: "complete",
      local_file: new File(["img"], "preview.png", { type: "image/png" }),
    });

    const view = renderCard(imageClip);
    await waitFor(() => expect(createObjectUrlSpy).toHaveBeenCalledWith(imageClip.local_file));

    view.rerender(
      <ClipCard
        clip={buildClip({
          kind: "text",
          text_content: "replacement",
          local_file: null,
          local_only: false,
          local_origin: null,
          local_transfer_state: null,
        })}
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
        subscribeToSendProgress={() => () => undefined}
        subscribeToDirectTransfers={() => () => undefined}
      />
    );

    await waitFor(() => expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:local-image"));
  });
});
