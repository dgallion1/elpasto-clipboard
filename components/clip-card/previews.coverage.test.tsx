// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

// Mock the preview hooks so we can drive PDF / zip branches without real blobs.
vi.mock("@/hooks/usePdfPreviews", () => ({
  usePdfPreviews: vi.fn(() => ({
    pages: null,
    isLimited: false,
    isExtracting: false,
  })),
}));
vi.mock("@/hooks/useZipImagePreviews", () => ({
  useZipImagePreviews: vi.fn(() => ({
    images: null,
    isLimited: false,
    isExtracting: false,
  })),
}));

import { usePdfPreviews } from "@/hooks/usePdfPreviews";
import { useZipImagePreviews } from "@/hooks/useZipImagePreviews";
import { PlainPreview, EncryptedPreview } from "./previews";
import type { Clip } from "@/lib/clips";

const mockUsePdfPreviews = vi.mocked(usePdfPreviews);
const mockUseZipImagePreviews = vi.mocked(useZipImagePreviews);

beforeEach(() => {
  mockUsePdfPreviews.mockReturnValue({
    pages: null,
    isLimited: false,
    isExtracting: false,
  });
  mockUseZipImagePreviews.mockReturnValue({
    images: null,
    isLimited: false,
    isExtracting: false,
  });
});

afterEach(() => cleanup());

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
    created_at: "2026-03-08T10:00:00Z",
    local_only: false,
    local_origin: null,
    local_transfer_state: null,
    local_file: null,
    ...overrides,
  } as Clip;
}

function commonPlainProps() {
  return {
    fileUrl: null,
    localImageUrl: null,
    directImageUrl: null,
    decryptedFileBlob: null,
    localFile: null,
    decryptedText: null,
    decryptedHtml: null,
    onDownload: vi.fn(),
    awaitingDirectTransfer: false,
    peerAvailableForTransfer: false,
    transferStats: null,
  };
}

function commonEncryptedProps() {
  return {
    awaitingDirectTransfer: false,
    decryptError: null,
    decryptedFileBlob: null,
    decryptedHtml: null,
    decryptedImageUrl: null,
    decryptedText: null,
    fileReadyState: "ready" as const,
    isDecrypting: false,
    onDownload: vi.fn(),
    onUnlock: vi.fn(),
    peerAvailableForTransfer: false,
    transferStats: null,
    unlockSecret: null,
    hasSecret: true,
  };
}

describe("LinkedText trailing text after URL", () => {
  test("renders text after the final URL when the URL is not at the end", () => {
    const view = render(
      <PlainPreview
        {...commonPlainProps()}
        clip={buildClip({
          id: 901,
          kind: "text",
          text_content: "Visit https://example.com/help to learn more",
        })}
      />,
    );
    const link = view.getByRole("link", {
      name: "https://example.com/help",
    });
    expect(link.getAttribute("href")).toBe("https://example.com/help");
    // The trailing " to learn more" must render after the link
    expect(view.container.textContent).toContain(" to learn more");
  });
});

describe("PlainPreview PDF carousel", () => {
  test("renders ZipImageCarousel with PDF page previews when usePdfPreviews returns pages", () => {
    mockUsePdfPreviews.mockReturnValue({
      pages: [
        { path: "#page=1", name: "p.1", url: "blob:page-1" },
        { path: "#page=2", name: "p.2", url: "blob:page-2" },
      ],
      isLimited: true,
      isExtracting: false,
    });

    const view = render(
      <PlainPreview
        {...commonPlainProps()}
        clip={buildClip({
          id: 902,
          kind: "file",
          mime_type: "application/pdf",
          original_name: "doc.pdf",
          size_bytes: 4096,
        })}
        fileUrl="http://example.test/doc.pdf"
      />,
    );

    // Hero image is the first PDF page preview
    expect(view.getAllByAltText("p.1")[0]?.getAttribute("src")).toBe(
      "blob:page-1",
    );
    expect(view.getByText("doc.pdf")).toBeTruthy();
    // The "Preview limited" notice from ZipImageCarousel proves isLimited propagated
    expect(view.getByText("Preview limited to first 20 items")).toBeTruthy();
  });
});

describe("EncryptedPreview editing modes", () => {
  test("text clip in edit mode renders the textarea", () => {
    const view = render(
      <EncryptedPreview
        {...commonEncryptedProps()}
        clip={buildClip({
          id: 910,
          kind: "text",
          mime_type: "text/plain",
          encrypted: true,
        })}
        decryptedText="decrypted text"
        isEditingContent
        canEditContent
        draftContent="draft text"
      />,
    );
    const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("draft text");
  });

  test("html clip in edit mode renders the textarea", () => {
    const view = render(
      <EncryptedPreview
        {...commonEncryptedProps()}
        clip={buildClip({
          id: 911,
          kind: "html",
          mime_type: "text/html",
          encrypted: true,
        })}
        decryptedHtml="<p>hi</p>"
        isEditingContent
        canEditContent
        draftContent="rich draft"
      />,
    );
    const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("rich draft");
  });
});

describe("EncryptedPreview file branch carousels", () => {
  test("renders PDF carousel when decrypted file is a PDF with rendered pages", () => {
    mockUsePdfPreviews.mockReturnValue({
      pages: [
        { path: "#page=1", name: "p.1", url: "blob:enc-page-1" },
        { path: "#page=2", name: "p.2", url: "blob:enc-page-2" },
      ],
      isLimited: false,
      isExtracting: false,
    });

    const view = render(
      <EncryptedPreview
        {...commonEncryptedProps()}
        clip={buildClip({
          id: 920,
          kind: "file",
          mime_type: "application/pdf",
          original_name: "secret.pdf",
          size_bytes: 4096,
          encrypted: true,
        })}
        decryptedFileBlob={new Blob([new Uint8Array([1, 2, 3])])}
      />,
    );

    expect(view.getAllByAltText("p.1")[0]?.getAttribute("src")).toBe(
      "blob:enc-page-1",
    );
    expect(view.getByText("secret.pdf")).toBeTruthy();
  });

  test("renders zip carousel when decrypted file is a zip with image previews", () => {
    mockUseZipImagePreviews.mockReturnValue({
      images: [
        { path: "photo.png", name: "photo.png", url: "blob:enc-photo" },
      ],
      isLimited: true,
      isExtracting: false,
    });

    const view = render(
      <EncryptedPreview
        {...commonEncryptedProps()}
        clip={buildClip({
          id: 921,
          kind: "file",
          mime_type: "application/zip",
          original_name: "bundle.zip",
          size_bytes: 4096,
          encrypted: true,
        })}
        decryptedFileBlob={new Blob([new Uint8Array([1, 2, 3])])}
      />,
    );

    expect(view.getAllByAltText("photo.png")[0]?.getAttribute("src")).toBe(
      "blob:enc-photo",
    );
    expect(view.getByText("bundle.zip")).toBeTruthy();
    expect(view.getByText("Preview limited to first 20 items")).toBeTruthy();
  });
});

describe("EditablePreviewSurface keyboard activation", () => {
  test("Enter on the preview surface triggers onBeginEdit", () => {
    const onBeginEdit = vi.fn();
    const view = render(
      <PlainPreview
        {...commonPlainProps()}
        clip={buildClip({
          id: 930,
          kind: "text",
          text_content: "hello",
        })}
        canEditContent
        onBeginEdit={onBeginEdit}
      />,
    );

    const surface = view.getByRole("button");
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(onBeginEdit).toHaveBeenCalledTimes(1);
  });

  test("Space on the preview surface triggers onBeginEdit", () => {
    const onBeginEdit = vi.fn();
    const view = render(
      <PlainPreview
        {...commonPlainProps()}
        clip={buildClip({
          id: 931,
          kind: "text",
          text_content: "hello",
        })}
        canEditContent
        onBeginEdit={onBeginEdit}
      />,
    );

    const surface = view.getByRole("button");
    fireEvent.keyDown(surface, { key: " " });
    expect(onBeginEdit).toHaveBeenCalledTimes(1);
  });

  test("other keys do not trigger onBeginEdit", () => {
    const onBeginEdit = vi.fn();
    const view = render(
      <PlainPreview
        {...commonPlainProps()}
        clip={buildClip({
          id: 932,
          kind: "text",
          text_content: "hello",
        })}
        canEditContent
        onBeginEdit={onBeginEdit}
      />,
    );

    fireEvent.keyDown(view.getByRole("button"), { key: "a" });
    fireEvent.keyDown(view.getByRole("button"), { key: "Escape" });
    expect(onBeginEdit).not.toHaveBeenCalled();
  });
});

describe("ZoomableImage lightbox", () => {
  test("clicking the image opens the lightbox overlay", () => {
    const view = render(
      <PlainPreview
        {...commonPlainProps()}
        clip={buildClip({
          id: 940,
          kind: "image",
          mime_type: "image/png",
          original_name: "screenshot.png",
        })}
        localImageUrl="blob:local-screenshot"
      />,
    );

    // Before clicking, the lightbox image (max-h-[90vh]) shouldn't exist
    expect(
      view
        .queryAllByAltText("screenshot.png")
        .some((el) => el.className.includes("max-h-[90vh]")),
    ).toBe(false);

    const thumb = view.getAllByAltText("screenshot.png")[0]!;
    fireEvent.click(thumb);

    // After click, a second img with lightbox class should appear
    expect(
      view
        .getAllByAltText("screenshot.png")
        .some((el) => el.className.includes("max-h-[90vh]")),
    ).toBe(true);
  });

  test("closing the lightbox via Escape unmounts it", () => {
    const view = render(
      <PlainPreview
        {...commonPlainProps()}
        clip={buildClip({
          id: 941,
          kind: "image",
          mime_type: "image/png",
          original_name: "pic.png",
        })}
        localImageUrl="blob:pic"
      />,
    );

    fireEvent.click(view.getAllByAltText("pic.png")[0]!);
    expect(
      view
        .getAllByAltText("pic.png")
        .some((el) => el.className.includes("max-h-[90vh]")),
    ).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(
      view
        .queryAllByAltText("pic.png")
        .some((el) => el.className.includes("max-h-[90vh]")),
    ).toBe(false);
  });
});
