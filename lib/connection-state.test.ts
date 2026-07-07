import { describe, expect, test } from "vitest";
import { deriveConnectionState } from "./connection-state";
import type { PeerInfo } from "@/hooks/usePeerMesh";

const peer = (channelState: PeerInfo["channelState"]): PeerInfo => ({
  peerId: "p1",
  channelState,
  hasTunnel: false,
});

describe("deriveConnectionState", () => {
  test("no peers and no tunnels → waiting", () => {
    expect(deriveConnectionState({ peers: [], readyPeerCount: 0, tunnels: [] })).toBe("waiting");
  });

  test("a peer present but none open → connecting", () => {
    expect(
      deriveConnectionState({ peers: [peer("connecting")], readyPeerCount: 0, tunnels: [] })
    ).toBe("connecting");
    expect(
      deriveConnectionState({ peers: [peer("none")], readyPeerCount: 0, tunnels: [] })
    ).toBe("connecting");
  });

  test("an open channel → connected-direct (wins over tunnel)", () => {
    expect(
      deriveConnectionState({
        peers: [peer("open")],
        readyPeerCount: 1,
        tunnels: [{ peerId: "p1" }],
      })
    ).toBe("connected-direct");
  });

  test("tunnel active, no open direct channel → connected-tunnel", () => {
    expect(
      deriveConnectionState({ peers: [], readyPeerCount: 0, tunnels: [{ peerId: "p1" }] })
    ).toBe("connected-tunnel");
  });
});
