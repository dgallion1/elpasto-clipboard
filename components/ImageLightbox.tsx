"use client";

import { useCallback, useEffect } from "react";

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  counter?: string;
}

export function ImageLightbox({
  src,
  alt,
  onClose,
  onPrev,
  onNext,
  counter,
}: ImageLightboxProps) {
  const hasNav = !!(onPrev || onNext);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft") {
        onPrev?.();
      } else if (event.key === "ArrowRight") {
        onNext?.();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onPrev, onNext]);

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  const handleImageClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!hasNav) {
        onClose();
      }
    },
    [hasNav, onClose],
  );

  return (
    <div
      className={`group fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4${hasNav ? " cursor-default" : " cursor-zoom-out"}`}
      onClick={handleBackdropClick}
    >
      {onPrev && (
        <button
          type="button"
          className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-500 opacity-0 transition-all group-hover:opacity-100 hover:text-neutral-200 cursor-pointer z-10"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          aria-label="Previous image"
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}

      <div className="flex flex-col items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- blob URL from WebRTC/IndexedDB */}
        <img
          src={src}
          alt={alt}
          className={`max-h-[90vh] max-w-[90vw] rounded-lg object-contain${hasNav ? " cursor-default" : ""}`}
          onClick={handleImageClick}
        />
        {counter && (
          <span className="text-neutral-400 text-sm">{counter}</span>
        )}
      </div>

      {onNext && (
        <button
          type="button"
          className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral-500 opacity-0 transition-all group-hover:opacity-100 hover:text-neutral-200 cursor-pointer z-10"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          aria-label="Next image"
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}
    </div>
  );
}
