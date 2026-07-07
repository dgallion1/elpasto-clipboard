import type { PeerInfo } from "@/hooks/usePeerMesh";
import type { TunnelInfo } from "@/hooks/useTunnelRelay";

export type ConnectionState =
  | "waiting"
  | "connecting"
  | "connected-direct"
  | "connected-tunnel";

/**
 * A peer is "ready" (usable as a connected device) when its direct data
 * channel is open or it has an active mesh tunnel. This is the single source
 * of truth for readiness — used both to count ready peers for state derivation
 * and to label the connection pill.
 */
export function isPeerReady(peer: PeerInfo): boolean {
  return peer.channelState === "open" || peer.hasTunnel;
}

/** Screen-reader announcement for each connection state (empty = silent). */
export const connectionAnnouncement: Record<ConnectionState, string> = {
  waiting: "",
  connecting: "Device connecting",
  "connected-direct": "Device connected",
  "connected-tunnel": "Device connected via relay",
};

/**
 * Derive a single connection state from mesh + tunnel data the hooks already
 * expose. Precedence: an open direct channel always wins; then an active
 * tunnel; then any present-but-not-open peer counts as "connecting"; otherwise
 * we are alone and "waiting".
 */
export function deriveConnectionState(input: {
  peers: PeerInfo[];
  readyPeerCount: number;
  tunnels: TunnelInfo[];
}): ConnectionState {
  const { peers, readyPeerCount, tunnels } = input;
  if (readyPeerCount > 0) return "connected-direct";
  if (tunnels.length > 0) return "connected-tunnel";
  if (peers.length > 0) return "connecting";
  return "waiting";
}
