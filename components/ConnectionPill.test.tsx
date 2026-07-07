// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ConnectionPill } from "./ConnectionPill";
import type { PeerInfo } from "@/hooks/usePeerMesh";

const peer = (peerId: string): PeerInfo => ({ peerId, channelState: "open", hasTunnel: false });

afterEach(() => cleanup());

describe("ConnectionPill", () => {
  test("renders nothing while waiting", () => {
    const view = render(
      <ConnectionPill state="waiting" peers={[]} peerNames={{}} onClick={() => undefined} />
    );
    expect(view.container.firstChild).toBeNull();
  });

  test("shows Linking… while connecting", () => {
    const view = render(
      <ConnectionPill state="connecting" peers={[peer("p1")]} peerNames={{}} onClick={() => undefined} />
    );
    expect(view.getByText("Linking…")).toBeTruthy();
  });

  test("shows the peer name when one device is connected", () => {
    const view = render(
      <ConnectionPill
        state="connected-direct"
        peers={[peer("p1")]}
        peerNames={{ p1: "Laptop" }}
        onClick={() => undefined}
      />
    );
    expect(view.getByText("Laptop")).toBeTruthy();
  });

  test("shows a device count when multiple are connected", () => {
    const view = render(
      <ConnectionPill
        state="connected-direct"
        peers={[peer("p1"), peer("p2")]}
        peerNames={{}}
        onClick={() => undefined}
      />
    );
    expect(view.getByText("2 devices")).toBeTruthy();
  });

  test("ignores peers that are not ready when counting devices", () => {
    const connecting: PeerInfo = { peerId: "p2", channelState: "connecting", hasTunnel: false };
    const view = render(
      <ConnectionPill
        state="connected-direct"
        peers={[peer("p1"), connecting]}
        peerNames={{ p1: "Laptop" }}
        onClick={() => undefined}
      />
    );
    expect(view.getByText("Laptop")).toBeTruthy();
  });

  test("counts tunneled peers as connected", () => {
    const tunneled: PeerInfo = { peerId: "p2", channelState: "none", hasTunnel: true };
    const view = render(
      <ConnectionPill
        state="connected-direct"
        peers={[peer("p1"), tunneled]}
        peerNames={{}}
        onClick={() => undefined}
      />
    );
    expect(view.getByText("2 devices")).toBeTruthy();
  });

  test("appends · relay for tunnel connections and fires onClick", () => {
    const onClick = vi.fn();
    const view = render(
      <ConnectionPill
        state="connected-tunnel"
        peers={[peer("p1")]}
        peerNames={{ p1: "Laptop" }}
        onClick={onClick}
      />
    );
    expect(view.getByText("Laptop · relay")).toBeTruthy();
    fireEvent.click(view.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
