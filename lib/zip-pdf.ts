interface PdfJsModule {
  getDocument(params: { data: Uint8Array }): {
    promise: Promise<PdfDocument>;
  };
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): void;
}

interface PdfPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvasContext: OffscreenCanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
  cleanup(): void;
}

export interface PdfPagePreview {
  pageNum: number;
  data: Uint8Array;
  mimeType: "image/png";
}

export interface RenderPdfResult {
  pages: PdfPagePreview[];
  totalPageCount: number;
}

export interface RenderPdfOptions {
  maxPages?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_PAGES = 20;
const RENDER_SCALE = 1.5;
const EMPTY_RESULT: RenderPdfResult = { pages: [], totalPageCount: 0 };

let pdfJsPromise: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  pdfJsPromise ??= (async () => {
    const pdfjsPromise = import("pdfjs-dist");
    const workerPromise = import(
      // @ts-expect-error pdfjs-dist does not ship a declaration for its worker entrypoint.
      "pdfjs-dist/build/pdf.worker.mjs"
    );
    const [pdfjs, workerModule] = await Promise.all([
      pdfjsPromise,
      workerPromise,
    ]);

    const globalWithPdfWorker = globalThis as typeof globalThis & {
      pdfjsWorker?: unknown;
    };
    globalWithPdfWorker.pdfjsWorker ??= workerModule;

    return pdfjs as unknown as PdfJsModule;
  })();

  return pdfJsPromise;
}

export async function renderPdfPages(
  pdfBytes: Uint8Array,
  { maxPages = DEFAULT_MAX_PAGES, signal }: RenderPdfOptions = {},
): Promise<RenderPdfResult> {
  if (signal?.aborted || typeof OffscreenCanvas === "undefined") {
    return EMPTY_RESULT;
  }

  let pdfjs: PdfJsModule;
  try {
    pdfjs = await loadPdfJs();
  } catch {
    return EMPTY_RESULT;
  }

  let document: PdfDocument | null = null;
  try {
    document = await pdfjs.getDocument({ data: pdfBytes }).promise;
    if (signal?.aborted) {
      return EMPTY_RESULT;
    }

    const totalPageCount = document.numPages;
    const pages: PdfPagePreview[] = [];

    for (let pageNum = 1; pageNum <= Math.min(totalPageCount, maxPages); pageNum++) {
      if (signal?.aborted) {
        return EMPTY_RESULT;
      }

      const page = await document.getPage(pageNum);
      try {
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = new OffscreenCanvas(
          Math.max(1, Math.ceil(viewport.width)),
          Math.max(1, Math.ceil(viewport.height)),
        );
        const context = canvas.getContext("2d");
        if (!context) {
          return EMPTY_RESULT;
        }

        await page.render({ canvasContext: context, viewport }).promise;
        if (signal?.aborted) {
          return EMPTY_RESULT;
        }

        const blob = await canvas.convertToBlob({ type: "image/png" });
        const buffer = await blob.arrayBuffer();
        pages.push({
          pageNum,
          data: new Uint8Array(buffer),
          mimeType: "image/png",
        });
      } finally {
        page.cleanup();
      }
    }

    return { pages, totalPageCount };
  } catch {
    return EMPTY_RESULT;
  } finally {
    document?.destroy();
  }
}
