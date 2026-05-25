import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { renderPdfPages } from "@/lib/zip-pdf";

export interface PdfPreview {
  path: string;
  name: string;
  url: string;
}

export interface PdfPreviewsResult {
  pages: PdfPreview[] | null;
  isLimited: boolean;
  isExtracting: boolean;
}

const IDLE: PdfPreviewsResult = {
  pages: null,
  isLimited: false,
  isExtracting: false,
};

const MAX_PDF_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_RENDERED_PAGES = 20;

/**
 * Renders page previews from a standalone PDF blob.
 * Mirrors the useZipImagePreviews pattern with ref-based external store.
 */
export function usePdfPreviews(
  source: Blob | File | null,
  isPdf: boolean,
): PdfPreviewsResult {
  const active = isPdf && source != null;

  const storeRef = useRef<PdfPreviewsResult>(IDLE);
  const listenersRef = useRef<Set<() => void>>(new Set());
  const urlsRef = useRef<string[]>([]);

  const subscribe = useCallback((cb: () => void) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);

  const getSnapshot = useCallback(() => storeRef.current, []);

  const emit = useCallback((next: PdfPreviewsResult) => {
    storeRef.current = next;
    for (const cb of listenersRef.current) cb();
  }, []);

  useEffect(() => {
    if (!active || !source) {
      emit(IDLE);
      return;
    }

    if (source.size > MAX_PDF_SOURCE_BYTES) {
      emit({ pages: [], isLimited: false, isExtracting: false });
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    emit({ pages: null, isLimited: false, isExtracting: true });

    (async () => {
      try {
        const buffer = await source.arrayBuffer();
        if (cancelled) return;

        const { pages, totalPageCount } = await renderPdfPages(
          new Uint8Array(buffer),
          { maxPages: MAX_RENDERED_PAGES, signal: abortController.signal },
        );
        if (cancelled) return;

        const previews: PdfPreview[] = pages.map((page) => {
          const blob = new Blob([page.data as BlobPart], { type: page.mimeType });
          const url = URL.createObjectURL(blob);
          return {
            path: `#page=${page.pageNum}`,
            name: `p.${page.pageNum}`,
            url,
          };
        });

        urlsRef.current = previews.map((p) => p.url);
        if (cancelled) {
          for (const url of urlsRef.current) URL.revokeObjectURL(url);
          urlsRef.current = [];
          return;
        }

        emit({
          pages: previews,
          isLimited: totalPageCount > pages.length,
          isExtracting: false,
        });
      } catch {
        if (!cancelled) {
          emit({ pages: [], isLimited: false, isExtracting: false });
        }
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
      for (const url of urlsRef.current) {
        URL.revokeObjectURL(url);
      }
      urlsRef.current = [];
    };
  }, [source, isPdf, active, emit]);

  return useSyncExternalStore(subscribe, getSnapshot, () => IDLE);
}
