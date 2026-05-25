"use client";

import { useEffect, useRef, useState } from "react";
import type { TunnelInfo } from "@/hooks/useTunnelRelay";

interface TunnelBadgeProps {
  tunnels: TunnelInfo[];
  swReady: boolean;
  peerNames: Record<string, string>;
  onOpen: (peerId: string) => void;
  onRemove: (peerId: string) => void;
  onShowHelp: () => void;
}

function tunnelDisplayName(tunnel: TunnelInfo, peerNames: Record<string, string>): string {
  return peerNames[tunnel.peerId] ?? tunnel.peerId.slice(0, 8);
}

export function TunnelBadge({ tunnels, swReady, peerNames, onOpen, onRemove, onShowHelp }: TunnelBadgeProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const effectiveOpen = open && tunnels.length > 0;

  if (tunnels.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={effectiveOpen}
        className="rounded-full border border-sky-900 bg-sky-950/60 px-2 py-0.5 text-xs text-sky-300 hover:bg-sky-900/40 transition-colors cursor-pointer"
      >
        {tunnels.length === 1 ? "1 tunnel" : `${tunnels.length} tunnels`}
      </button>
      {effectiveOpen && (
        <div
          role="menu"
          className="absolute top-full left-0 mt-1 z-10 rounded-md border border-neutral-700 bg-neutral-800 p-1.5 shadow-lg min-w-[180px]"
        >
          {tunnels.map((tunnel) => (
            <div key={tunnel.peerId} className="flex items-center gap-1 rounded hover:bg-neutral-700/50 transition-colors">
              <button
                role="menuitem"
                onClick={() => { onOpen(tunnel.peerId); setOpen(false); }}
                className="flex flex-1 min-w-0 flex-col px-2 py-1 text-left cursor-pointer"
              >
                <span className="text-xs text-neutral-200 font-mono truncate">
                  {tunnelDisplayName(tunnel, peerNames)}
                </span>
                {(tunnel.label || tunnel.port) && (
                  <span className="text-[10px] text-neutral-500 truncate">
                    {[tunnel.label, tunnel.port != null ? `:${tunnel.port}` : null].filter(Boolean).join(" ")}
                  </span>
                )}
              </button>
              <button
                role="menuitem"
                aria-label="Remove tunnel"
                onClick={(e) => { e.stopPropagation(); onRemove(tunnel.peerId); }}
                className="shrink-0 px-1.5 py-1 text-neutral-600 hover:text-red-400 transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>
          ))}
          {!swReady && tunnels.some(t => !t.serverRelay) && (
            <p className="border-t border-neutral-700 mt-1 pt-1 px-2 py-0.5 text-[10px] text-neutral-500">
              Activating relay…
            </p>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onShowHelp();
              setOpen(false);
            }}
            className="w-full border-t border-neutral-700 mt-1 pt-1 px-2 py-0.5 text-left text-[10px] text-neutral-500 transition-colors hover:text-sky-300"
          >
            Host a tunnel...
          </button>
        </div>
      )}
    </div>
  );
}
