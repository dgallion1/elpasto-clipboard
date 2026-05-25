"use client";

import { useEffect } from "react";
import type { IdentifyFlashEvent } from "@/hooks/usePeerMesh";

interface IdentifyFlashOverlayProps {
  flash: IdentifyFlashEvent | null;
  peerNames: Record<string, string>;
  onDone: (flashId: number) => void;
}

export function IdentifyFlashOverlay({ flash, peerNames, onDone }: IdentifyFlashOverlayProps) {
  useEffect(() => {
    if (!flash) return;

    const timer = setTimeout(() => {
      onDone(flash.id);
    }, 1500);

    return () => clearTimeout(timer);
  }, [flash, onDone]);

  if (!flash) return null;

  const label = peerNames[flash.fromPeerId] || flash.fromPeerId.slice(0, 8);

  return (
    <div
      key={flash.id}
      className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center animate-identify-flash"
    >
      <div className="rounded-2xl bg-emerald-500/20 border-2 border-emerald-400/60 px-8 py-6 backdrop-blur-sm">
        <p className="text-2xl font-bold text-emerald-300 text-center">
          Pinged by {label}
        </p>
      </div>
    </div>
  );
}
