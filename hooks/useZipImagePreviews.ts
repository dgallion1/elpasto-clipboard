import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { extractImagesFromZip } from "@/lib/zip-images";
import { renderPdfPages } from "@/lib/zip-pdf";

export interface ZipImagePreview {
  path: string;
  name: string;
  url: string;
}

export interface ZipImagePreviewsResult {
  images: ZipImagePreview[] | null;
  isLimited: boolean;
  isExtracting: boolean;
}

const IDLE: ZipImagePreviewsResult = {
  images: null,
  isLimited: false,
  isExtracting: false,
};
const MAX_ZIP_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_RENDERED_PREVIEW_ITEMS = 20;

/**
 * Extracts image previews from a zip blob and manages blob URL lifecycle.
 *
 * - `images: null` → not a zip / not applicable
 * - `images: []`   → valid zip with no images
 * - `images: [...]` → zip with image previews
 *
 * Uses a ref-based store to avoid synchronous setState inside useEffect,
 * which is forbidden by the react-hooks/set-state-in-effect lint rule.
 */
export function useZipImagePreviews(
  source: Blob | File | null,
  isZip: boolean,
): ZipImagePreviewsResult {
  const active = isZip && source != null;

  // Ref-based external store to sidestep the lint rule
  const storeRef = useRef<ZipImagePreviewsResult>(IDLE);
  const listenersRef = useRef<Set<() => void>>(new Set());
  const urlsRef = useRef<string[]>([]);

  const subscribe = useCallback((cb: () => void) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);

  const getSnapshot = useCallback(() => storeRef.current, []);

  const emit = useCallback((next: ZipImagePreviewsResult) => {
    storeRef.current = next;
    for (const cb of listenersRef.current) cb();
  }, []);

  useEffect(() => {
    if (!active || !source) {
      emit(IDLE);
      return;
    }

    if (source.size > MAX_ZIP_SOURCE_BYTES) {
      emit({ images: [], isLimited: false, isExtracting: false });
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    emit({ images: null, isLimited: false, isExtracting: true });

    (async () => {
      try {
        const buffer = await source.arrayBuffer();
        if (cancelled) return;

        const { images: entries, totalEntryCount } = await extractImagesFromZip(
          new Uint8Array(buffer),
          { signal: abortController.signal },
        );
        if (cancelled) return;

        let isLimited = totalEntryCount > entries.length;
        const previewEntries: Array<{
          path: string;
          name: string;
          fallbackName: string;
          blob: Blob;
        }> = [];

        for (const entry of entries) {
          const remainingSlots = MAX_RENDERED_PREVIEW_ITEMS - previewEntries.length;
          if (remainingSlots <= 0) {
            isLimited = true;
            break;
          }

          if (entry.type === "pdf") {
            const { pages, totalPageCount } = await renderPdfPages(entry.data, {
              maxPages: remainingSlots,
              signal: abortController.signal,
            });
            if (cancelled) return;

            if (totalPageCount > pages.length) {
              isLimited = true;
            }

            for (const page of pages) {
              const pageName = `${entry.name} p.${page.pageNum}`;
              const pagePath = `${entry.path}#page=${page.pageNum}`;
              previewEntries.push({
                path: pagePath,
                name: pageName,
                fallbackName: `${entry.path} p.${page.pageNum}`,
                blob: new Blob([page.data as BlobPart], { type: page.mimeType }),
              });
            }
            continue;
          }

          previewEntries.push({
            path: entry.path,
            name: entry.name,
            fallbackName: entry.path,
            blob: new Blob([entry.data as BlobPart], { type: entry.mimeType }),
          });
        }

        const duplicateCounts = new Map<string, number>();
        for (const entry of previewEntries) {
          duplicateCounts.set(
            entry.name,
            (duplicateCounts.get(entry.name) ?? 0) + 1,
          );
        }

        const previews: ZipImagePreview[] = previewEntries.map((entry) => {
          const url = URL.createObjectURL(entry.blob);
          return {
            path: entry.path,
            name:
              (duplicateCounts.get(entry.name) ?? 0) > 1
                ? entry.fallbackName
                : entry.name,
            url,
          };
        });

        // Store URLs before the cancellation check so cleanup always revokes them
        urlsRef.current = previews.map((p) => p.url);
        if (cancelled) {
          for (const url of urlsRef.current) URL.revokeObjectURL(url);
          urlsRef.current = [];
          return;
        }
        emit({
          images: previews,
          isLimited,
          isExtracting: false,
        });
      } catch {
        if (!cancelled) {
          emit({ images: [], isLimited: false, isExtracting: false });
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
  }, [source, isZip, active, emit]);

  return useSyncExternalStore(subscribe, getSnapshot, () => IDLE);
}
