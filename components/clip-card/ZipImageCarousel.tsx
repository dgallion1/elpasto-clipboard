"use client";

import { useCallback, useState } from "react";
import { ImageLightbox } from "@/components/ImageLightbox";

interface ZipImageCarouselProps {
  images: { path: string; name: string; url: string }[];
  isLimited: boolean;
  zipName: string | null;
  zipNote: string;
  userNote?: string | null;
  onDownload: () => void | Promise<void>;
}

export function ZipImageCarousel({
  images,
  isLimited,
  zipName,
  zipNote,
  userNote,
  onDownload,
}: ZipImageCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Clamp index to valid range if images array shrinks (e.g. re-extraction)
  const safeIndex = activeIndex < images.length ? activeIndex : 0;
  const active = images[safeIndex];

  const goToPrev = useCallback(() => {
    setActiveIndex((i) => (i === 0 ? images.length - 1 : i - 1));
  }, [images.length]);

  const goToNext = useCallback(() => {
    setActiveIndex((i) => (i === images.length - 1 ? 0 : i + 1));
  }, [images.length]);

  if (!active) return null;

  return (
    <div className="space-y-2">
      {/* Hero image */}
      {/* eslint-disable-next-line @next/next/no-img-element -- blob URL from WebRTC/IndexedDB */}
      <img
        src={active.url}
        alt={active.name}
        className="max-h-48 cursor-zoom-in rounded object-contain"
        onClick={() => setLightboxOpen(true)}
      />

      {/* Thumbnail strip */}
      {images.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {images.map((img, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- blob URL from WebRTC/IndexedDB
            <img
              key={img.path}
              src={img.url}
              alt={img.name}
              className={`h-10 w-10 shrink-0 cursor-pointer rounded object-cover${
                i === safeIndex ? " ring-2 ring-blue-500" : ""
              }`}
              onClick={() => setActiveIndex(i)}
            />
          ))}
        </div>
      )}

      {/* Limited preview indicator */}
      {isLimited && (
        <p className="text-xs text-neutral-500">
          Preview limited to first 20 items
        </p>
      )}

      {/* File info + download */}
      <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-neutral-700 bg-neutral-900/70 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-neutral-200">
            {zipName || "Archive"}
          </div>
          <div className="text-xs text-neutral-500">{zipNote}</div>
          {userNote && (
            <div className="mt-1 text-xs text-neutral-400 italic">
              {userNote}
            </div>
          )}
        </div>
        <button
          onClick={onDownload}
          className="shrink-0 rounded bg-blue-700 px-3 py-1.5 text-sm text-neutral-100 transition-colors hover:bg-blue-600"
        >
          Download
        </button>
      </div>

      {/* Lightbox */}
      {lightboxOpen && (
        <ImageLightbox
          src={active.url}
          alt={active.name}
          onClose={() => setLightboxOpen(false)}
          onPrev={images.length > 1 ? goToPrev : undefined}
          onNext={images.length > 1 ? goToNext : undefined}
          counter={
            images.length > 1
              ? `${safeIndex + 1} / ${images.length}`
              : undefined
          }
        />
      )}
    </div>
  );
}
