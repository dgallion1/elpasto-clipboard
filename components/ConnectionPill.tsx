"use client";

import type { PeerInfo } from "@/hooks/usePeerMesh";
import type { ConnectionState } from "@/lib/connection-state";

interface ConnectionPillProps {
  state: ConnectionState;
  peers: PeerInfo[];
  peerNames: Record<string, string>;
  /** One-shot emerald ring when a connection is freshly established. */
  pulse?: boolean;
  onClick: () => void;
}

function connectedLabel(peers: PeerInfo[], peerNames: Record<string, string>): string {
  if (peers.length === 0) return "device";
  if (peers.length === 1) {
    const p = peers[0];
    return peerNames[p.peerId] ?? p.name ?? p.peerId.slice(0, 8);
  }
  return `${peers.length} devices`;
}

export function ConnectionPill({ state, peers, peerNames, pulse, onClick }: ConnectionPillProps) {
  if (state === "waiting") return null;

  if (state === "connecting") {
    return (
      <button
        onClick={onClick}
        aria-label="Connection status: linking to a device"
        className="flex items-center gap-1.5 rounded-full border border-amber-900 bg-amber-950/50 px-2 py-0.5 text-xs text-amber-300 transition-colors hover:bg-amber-900/40 cursor-pointer"
      >
        <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        Linking…
      </button>
    );
  }

  const isTunnel = state === "connected-tunnel";
  const label = connectedLabel(peers, peerNames);
  const ring = pulse ? "ring-2 ring-emerald-400/60" : "";
  return (
    <button
      onClick={onClick}
      aria-label={`Connection status: connected to ${label}${isTunnel ? " via relay" : ""}`}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-all cursor-pointer ${ring} ${
        isTunnel
          ? "border-sky-900 bg-sky-950/50 text-sky-300 hover:bg-sky-900/40"
          : "border-emerald-900 bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/40"
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${isTunnel ? "bg-sky-400" : "bg-emerald-400"}`} />
      {isTunnel ? `${label} · relay` : label}
    </button>
  );
}
