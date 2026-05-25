import { unzip } from "fflate";

export interface ZipImage {
  path: string;
  name: string;
  data: Uint8Array;
  mimeType: string;
  type: "image" | "pdf";
}

export interface ExtractResult {
  images: ZipImage[];
  totalEntryCount: number;
}

export interface ExtractOptions {
  limit?: number;
  maxImageBytes?: number;
  maxTotalPreviewBytes?: number;
  signal?: AbortSignal;
}

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  pdf: "application/pdf",
};

const PREVIEWABLE_EXTENSIONS = new Set(Object.keys(EXT_TO_MIME));
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_PREVIEW_BYTES = 24 * 1024 * 1024;

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function isPreviewablePath(path: string): boolean {
  if (path.startsWith("__MACOSX/") || path.includes("/__MACOSX/")) return false;

  const name = basename(path);
  if (!name || name.startsWith(".")) return false;

  return PREVIEWABLE_EXTENSIONS.has(getExtension(name));
}

/**
 * Extract previewable image/PDF entries from a zip archive.
 *
 * Filters out __MACOSX/ entries and dotfiles, caps extraction work up front,
 * and returns at most `limit` entries (default 20).
 * Returns totalEntryCount so the UI can signal truncated previews.
 */
export function extractImagesFromZip(
  zipBytes: Uint8Array,
  {
    limit = DEFAULT_LIMIT,
    maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
    maxTotalPreviewBytes = DEFAULT_MAX_TOTAL_PREVIEW_BYTES,
    signal,
  }: ExtractOptions = {},
): Promise<ExtractResult> {
  return new Promise((resolve) => {
    let done = false;
    let totalEntryCount = 0;
    let selectedPreviewBytes = 0;
    let terminate: (() => void) | null = null;
    const selectedImages: Array<
      Pick<ZipImage, "path" | "name" | "mimeType" | "type">
    > =
      [];

    const finish = (result: ExtractResult) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", handleAbort);
      if (terminate) {
        signal?.removeEventListener("abort", terminate);
      }
      resolve(result);
    };

    const handleAbort = () => {
      finish({ images: [], totalEntryCount: 0 });
    };

    if (signal?.aborted) {
      finish({ images: [], totalEntryCount: 0 });
      return;
    }

    signal?.addEventListener("abort", handleAbort, { once: true });

    try {
      terminate = unzip(
        zipBytes,
        {
          filter(file) {
            if (!isPreviewablePath(file.name)) return false;

            totalEntryCount += 1;

            if (selectedImages.length >= limit) return false;
            if (file.originalSize > maxImageBytes) return false;
            if (selectedPreviewBytes + file.originalSize > maxTotalPreviewBytes) {
              return false;
            }

            const name = basename(file.name);
            const ext = getExtension(name);

            selectedImages.push({
              path: file.name,
              name,
              mimeType: EXT_TO_MIME[ext],
              type: ext === "pdf" ? "pdf" : "image",
            });
            selectedPreviewBytes += file.originalSize;
            return true;
          },
        },
        (error, entries) => {
          if (error) {
            finish({ images: [], totalEntryCount: 0 });
            return;
          }

          const images = selectedImages
            .filter((image) => entries[image.path])
            .map((image) => ({
              ...image,
              data: entries[image.path],
            }))
            .sort((a, b) => (
              a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
            ));

          finish({
            images,
            totalEntryCount,
          });
        },
      );

      if (signal && terminate) {
        signal.addEventListener("abort", terminate, { once: true });
      }
    } catch {
      finish({ images: [], totalEntryCount: 0 });
    }
  });
}
