import type { PeerInfo } from "@/hooks/usePeerMesh";
import type { TunnelInfo } from "@/hooks/useTunnelRelay";

export type ConnectionState =
  | "waiting"
  | "connecting"
  | "connected-direct"
  | "connected-tunnel";

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
