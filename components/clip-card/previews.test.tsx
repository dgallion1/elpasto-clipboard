// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/hooks/useZipImagePreviews", () => ({
  useZipImagePreviews: vi.fn(() => ({
    images: null,
    isLimited: false,
    isExtracting: false,
  })),
}));

import { useZipImagePreviews } from "@/hooks/useZipImagePreviews";
import { PlainPreview, EncryptedPreview } from "./previews";

afterEach(() => {
  cleanup();
});
import type { Clip } from "@/lib/clips";
import type { TransferStats } from "@/lib/direct-transfer";

function buildClip(overrides: Partial<Clip>): Clip {
  return {
    id: 1,
    session_id: 1,
    zone: "A",
    kind: "text",
    client_transfer_id: null,
    mime_type: null,
    text_content: null,
    html_content: null,
    storage_key: null,
    original_name: null,
    size_bytes: null,
    encrypted: false,
    encryption_version: null,
    encryption_meta: null,
    created_at: new Date("2026-03-12T12:00:00.000Z").toISOString(),
    ...overrides,
  };
}

const mockTextClip: Clip = buildClip({
  id: 101,
  text_content: "Hello World",
});

const mockHtmlClip: Clip = buildClip({
  id: 102,
  kind: "html",
  html_content: "<strong>Hello</strong>",
});

const mockImageClip: Clip = buildClip({
  id: 103,
  kind: "image",
  mime_type: "image/png",
  original_name: "test.png",
  size_bytes: 1024,
});

const mockFileClip: Clip = buildClip({
  id: 104,
  kind: "file",
  mime_type: "application/pdf",
  original_name: "document.pdf",
  size_bytes: 2048,
});

describe("PlainPreview", () => {
  it("renders text clip", () => {
    render(
      <PlainPreview
        clip={mockTextClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(screen.getByText("Hello World")).toBeDefined();
  });

  it("renders decrypted text clip when provided", () => {
    render(
      <PlainPreview
        clip={mockTextClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={"Decrypted Text Message"}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(screen.getByText("Decrypted Text Message")).toBeDefined();
  });

  it("renders html clip", () => {
    const { container } = render(
      <PlainPreview
        clip={mockHtmlClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(container.innerHTML).toContain("<strong>Hello</strong>");
  });

  it("renders decrypted html clip", () => {
    const { container } = render(
      <PlainPreview
        clip={mockHtmlClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={"<em>Decrypted HTML</em>"}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(container.innerHTML).toContain("<em>Decrypted HTML</em>");
  });

  it("renders image clip with localImageUrl", () => {
    render(
      <PlainPreview
        clip={mockImageClip}
        fileUrl={null}
        localImageUrl="blob:local-image-url"
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    const img = screen.getByAltText("test.png");
    expect(img.getAttribute("src")).toBe("blob:local-image-url");
  });

  it("renders file ready state download button", () => {
    const onDownloadMock = vi.fn();
    render(
      <PlainPreview
        clip={mockFileClip}
        fileUrl="http://example.com/file"
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={onDownloadMock}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(screen.getByText("document.pdf")).toBeDefined();

    const downloadBtn = screen.getByText("Download");
    fireEvent.click(downloadBtn);
    expect(onDownloadMock).toHaveBeenCalled();
  });

  it("renders awaiting direct transfer - waiting for peer", () => {
    render(
      <PlainPreview
        clip={mockFileClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={true}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(screen.getByText("Waiting for a peer that has this file to connect...")).toBeDefined();
  });

  it("renders awaiting direct transfer - requesting file", () => {
    render(
      <PlainPreview
        clip={mockFileClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={true}
        peerAvailableForTransfer={true}
        transferStats={null}
      />,
    );
    expect(screen.getByText("Peer connected. Requesting the file...")).toBeDefined();
  });

  it("renders awaiting direct transfer - transferring with stats", () => {
    const transferStats: TransferStats = {
      totalBytes: 1000,
      bytesReceived: 500,
      progress: 0.5,
      speedBps: 2000,
    };
    render(
      <PlainPreview
        clip={mockFileClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={true}
        peerAvailableForTransfer={true}
        transferStats={transferStats}
      />,
    );
    expect(screen.getByText("Transferring directly from sender...")).toBeDefined();
    expect(screen.getByText("Receiving... 500 B / 1000 B")).toBeDefined();
    expect(screen.getByText("2.0 KB/s · 50%")).toBeDefined();
  });

  it("renders awaiting direct transfer - failed", () => {
    const failedClip: Clip = { ...mockFileClip, local_transfer_state: "failed" };
    render(
      <PlainPreview
        clip={failedClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={true}
        peerAvailableForTransfer={true}
        transferStats={null}
      />,
    );
    expect(screen.getByText("Direct transfer stalled before completion. Ask the sender to retry.")).toBeDefined();
  });

  it("renders fallback FileSummary if not ready and not awaiting direct transfer", () => {
    render(
      <PlainPreview
        clip={mockFileClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={true}
        transferStats={null}
      />,
    );
    expect(screen.getByText("document.pdf")).toBeDefined();
    expect(screen.queryByText("Download")).toBeNull();
  });
});

describe("EncryptedPreview", () => {
  it("renders decrypted text when text is present", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockTextClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText="Here is the decrypted secret text"
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret="secret123"
      />,
    );
    expect(screen.getByText("Here is the decrypted secret text")).toBeDefined();
  });

  it("renders decrypted html when html is present", () => {
    const { container } = render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockHtmlClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml="<b>Secret HTML</b>"
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret="secret123"
      />,
    );
    expect(container.innerHTML).toContain("<b>Secret HTML</b>");
  });

  it("renders decrypted image", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockImageClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl="blob:secret-image"
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret="secret123"
      />,
    );
    const img = screen.getByAltText("test.png");
    expect(img.getAttribute("src")).toBe("blob:secret-image");
  });

  it("renders decrypted file download ready", () => {
    const onDownloadMock = vi.fn();
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockFileClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="ready"
        isDecrypting={false}
        onDownload={onDownloadMock}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret="secret123"
      />,
    );
    const downloadBtn = screen.getByText("Download");
    fireEvent.click(downloadBtn);
    expect(onDownloadMock).toHaveBeenCalled();
  });

  it("renders locked file basic state and unlock button", () => {
    const onUnlockMock = vi.fn();
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockFileClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={onUnlockMock}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret={null}
      />,
    );
    expect(screen.getByText("Encrypted")).toBeDefined();
    expect(screen.getByText("document.pdf")).toBeDefined();
    expect(screen.getByText("Provide the unlock secret to decrypt this clip locally.")).toBeDefined();

    const unlockBtn = screen.getByText("Unlock");
    fireEvent.click(unlockBtn);
    expect(onUnlockMock).toHaveBeenCalled();
  });

  it("renders locked state when decrypting", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockFileClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={true}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret={null}
      />,
    );
    expect(screen.getByText("Decrypting in this browser...")).toBeDefined();
  });

  it("renders locked state when decrypting file with unlock secret", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockFileClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="decrypting"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret="secret123"
      />,
    );
    expect(screen.getByText("Decrypting file...")).toBeDefined();
  });

  it("renders decrypt error", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockFileClip}
        decryptError="Invalid password"
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret={null}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Invalid password");
  });

  it("renders awaiting direct transfer - failed", () => {
    const failedClip: Clip = { ...mockFileClip, local_transfer_state: "failed" };
    render(
      <EncryptedPreview
        awaitingDirectTransfer={true}
        clip={failedClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={true}
        transferStats={null}
        unlockSecret={null}
      />,
    );
    expect(screen.getByText("Direct transfer stalled before completion. Ask the sender to retry.")).toBeDefined();
  });

  it("renders awaiting direct transfer - transferring with stats", () => {
    const transferStats: TransferStats = {
      totalBytes: 5000,
      bytesReceived: 1000,
      progress: 0.2,
      speedBps: 2000,
    };
    render(
      <EncryptedPreview
        awaitingDirectTransfer={true}
        clip={mockFileClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={true}
        transferStats={transferStats}
        unlockSecret={null}
      />,
    );
    expect(screen.getByText("Transferring directly from sender...")).toBeDefined();
    expect(screen.getByText("Receiving... 1000 B / 4.9 KB")).toBeDefined();
    expect(screen.getByText("2.0 KB/s · 20%")).toBeDefined();
  });

  it("shows 'Encrypted file' label for image clip without original_name", () => {
    const imageNoName = buildClip({
      id: 200,
      kind: "image",
      original_name: null,
      encrypted: true,
    });
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={imageNoName}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret={null}
      />,
    );
    expect(screen.getByText("Encrypted file")).toBeDefined();
  });

  it("shows 'Locked rich text clip' for encrypted html clip", () => {
    const encryptedHtml = buildClip({
      id: 201,
      kind: "html",
      encrypted: true,
    });
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={encryptedHtml}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret={null}
      />,
    );
    expect(screen.getByText("Locked rich text clip")).toBeDefined();
  });

  it("shows 'Locked text clip' for encrypted text clip without secret", () => {
    const encryptedText = buildClip({
      id: 202,
      kind: "text",
      encrypted: true,
    });
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={encryptedText}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret={null}
      />,
    );
    expect(screen.getByText("Locked text clip")).toBeDefined();
  });

  it("shows 'File received. Decrypting...' for file with unlock secret and no special fileReadyState", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockFileClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret="secret123"
      />,
    );
    expect(screen.getByText("File received. Decrypting...")).toBeDefined();
  });

  it("shows 'Decrypting with the current unlock secret.' for text clip with unlock secret", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockTextClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret="secret123"
      />,
    );
    expect(screen.getByText("Decrypting with the current unlock secret.")).toBeDefined();
  });

  it("shows 'Peer connected. Requesting the encrypted file...' for encrypted awaiting transfer with peer", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={true}
        clip={mockFileClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={true}
        transferStats={null}
        unlockSecret={null}
      />,
    );
    expect(screen.getByText("Peer connected. Requesting the encrypted file...")).toBeDefined();
  });

  it("shows 'Waiting for a peer...' for encrypted awaiting transfer without peer", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={true}
        clip={mockFileClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret={null}
      />,
    );
    expect(screen.getByText("Waiting for a peer that has this clip to connect...")).toBeDefined();
  });

  it("hides Unlock button when unlock secret is set", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={mockTextClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret="my-secret"
      />,
    );
    expect(screen.queryByText("Unlock")).toBeNull();
  });

  it("hides Unlock button when awaiting direct transfer", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={true}
        clip={mockFileClip}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={null}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret={null}
      />,
    );
    expect(screen.queryByText("Unlock")).toBeNull();
  });
});

describe("PlainPreview image fallback", () => {
  it("renders image with directImageUrl when localImageUrl is not available", () => {
    render(
      <PlainPreview
        clip={buildClip({ id: 300, kind: "image", original_name: "dir.png" })}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl="blob:direct-image"
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(screen.getByAltText("dir.png").getAttribute("src")).toBe("blob:direct-image");
  });

  it("renders image with fileUrl when both local and direct URLs are not available", () => {
    render(
      <PlainPreview
        clip={buildClip({ id: 301, kind: "image", original_name: "remote.png" })}
        fileUrl="http://example.com/remote.png"
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(screen.getByAltText("remote.png").getAttribute("src")).toBe("http://example.com/remote.png");
  });

  it("renders file download with localFile", () => {
    const localFile = new File(["data"], "local.txt", { type: "text/plain" });
    render(
      <PlainPreview
        clip={buildClip({ id: 302, kind: "file", original_name: "local.txt", size_bytes: 4 })}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={localFile}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(screen.getByText("Download")).toBeDefined();
  });

  it("renders file download with decryptedFileBlob", () => {
    const blob = new Blob(["data"]);
    render(
      <PlainPreview
        clip={buildClip({ id: 303, kind: "file", original_name: "decrypted.bin", size_bytes: 4 })}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={blob}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(screen.getByText("Download")).toBeDefined();
  });

  it("renders 'Image' label for awaiting image without original_name", () => {
    render(
      <PlainPreview
        clip={buildClip({ id: 304, kind: "image", original_name: null })}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={true}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(screen.getByText("Image")).toBeDefined();
  });

  it("renders text with 'Loading text...' when no text_content or decryptedText", () => {
    render(
      <PlainPreview
        clip={buildClip({ id: 305, kind: "text", text_content: null })}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );
    expect(screen.getByText("Loading text...")).toBeDefined();
  });
});

describe("preview linkification", () => {
  it("links plain URLs without trailing punctuation", () => {
    render(
      <PlainPreview
        clip={buildClip({ id: 400, text_content: "Open https://example.com/docs." })}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );

    const link = screen.getByRole("link", { name: "https://example.com/docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(screen.getByText(/Open/).textContent).toContain("https://example.com/docs.");
  });

  it("keeps closing punctuation outside the generated URL", () => {
    const { container } = render(
      <PlainPreview
        clip={buildClip({ id: 401, text_content: "(https://example.com/path)" })}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );

    const link = screen.getByRole("link", { name: "https://example.com/path" });
    expect(link.getAttribute("href")).toBe("https://example.com/path");
    expect(container.textContent).toContain("(https://example.com/path)");
  });

  it("links standalone session tokens to local session routes", () => {
    render(
      <PlainPreview
        clip={buildClip({ id: 402, text_content: "amber-anchor-apple-arch-arrow" })}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={null}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );

    const link = screen.getByRole("link", { name: "amber-anchor-apple-arch-arrow" });
    expect(link.getAttribute("href")).toBe("/amber-anchor-apple-arch-arrow");
  });

  it("links decrypted encrypted text previews too", () => {
    render(
      <EncryptedPreview
        awaitingDirectTransfer={false}
        clip={buildClip({ id: 403, encrypted: true })}
        decryptError={null}
        decryptedFileBlob={null}
        decryptedHtml={null}
        decryptedImageUrl={null}
        decryptedText={"See https://example.com/help!"}
        fileReadyState="none"
        isDecrypting={false}
        onDownload={vi.fn()}
        onUnlock={vi.fn()}
        peerAvailableForTransfer={false}
        transferStats={null}
        unlockSecret={null}
      />,
    );

    const link = screen.getByRole("link", { name: "https://example.com/help" });
    expect(link.getAttribute("href")).toBe("https://example.com/help");
    expect(screen.getByText(/See/).textContent).toContain("https://example.com/help!");
  });
});

describe("PlainPreview zip carousel", () => {
  const mockUseZipImagePreviews = vi.mocked(useZipImagePreviews);

  afterEach(() => {
    mockUseZipImagePreviews.mockReturnValue({
      images: null,
      isLimited: false,
      isExtracting: false,
    });
  });

  const zipClip: Clip = buildClip({
    id: 500,
    kind: "file",
    mime_type: "application/zip",
    original_name: "photos.zip",
    size_bytes: 4096,
  });

  it("renders ZipImageCarousel when zip has images", () => {
    mockUseZipImagePreviews.mockReturnValue({
      images: [
        { path: "folder/a.png", name: "a.png", url: "blob:a" },
        { path: "folder/b.jpg", name: "b.jpg", url: "blob:b" },
      ],
      isLimited: true,
      isExtracting: false,
    });

    render(
      <PlainPreview
        clip={zipClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={new Blob(["zip"])}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );

    // Hero image + thumbnail both rendered for a.png
    const aPngs = screen.getAllByAltText("a.png");
    expect(aPngs.length).toBe(2); // hero + thumbnail
    // b.jpg only appears as thumbnail
    expect(screen.getByAltText("b.jpg")).toBeDefined();
    expect(screen.getByText("Preview limited to first 20 items")).toBeDefined();
    // Download button present
    expect(screen.getByText("Download")).toBeDefined();
  });

  it("renders FileSummary + Download for zip without images", () => {
    mockUseZipImagePreviews.mockReturnValue({
      images: [],
      isLimited: false,
      isExtracting: false,
    });

    render(
      <PlainPreview
        clip={zipClip}
        fileUrl={null}
        localImageUrl={null}
        directImageUrl={null}
        decryptedFileBlob={new Blob(["zip"])}
        localFile={null}
        decryptedText={null}
        decryptedHtml={null}
        onDownload={vi.fn()}
        awaitingDirectTransfer={false}
        peerAvailableForTransfer={false}
        transferStats={null}
      />,
    );

    expect(screen.getByText("photos.zip")).toBeDefined();
    expect(screen.getByText("Download")).toBeDefined();
    // No images rendered
    expect(screen.queryByRole("img")).toBeNull();
  });
});
