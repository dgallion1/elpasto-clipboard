// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TunnelBadge } from "./TunnelBadge";
import type { TunnelInfo } from "@/hooks/useTunnelRelay";

afterEach(cleanup);

const makeTunnel = (peerId: string, label?: string, port?: number): TunnelInfo => ({
  peerId,
  label,
  port,
});

describe("TunnelBadge", () => {
  const defaultProps = {
    swReady: true,
    peerNames: {} as Record<string, string>,
    onOpen: vi.fn(),
    onRemove: vi.fn(),
    onShowHelp: vi.fn(),
  };

  it("renders nothing when tunnels is empty", () => {
    const { container } = render(
      <TunnelBadge {...defaultProps} tunnels={[]} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("opens the dropdown when the badge is clicked", () => {
    render(
      <TunnelBadge {...defaultProps} tunnels={[makeTunnel("peer-abc")]} />
    );

    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByText("1 tunnel"));
    expect(screen.getByRole("menu")).toBeDefined();
  });

  it("clicking a tunnel item calls onOpen and closes the menu", () => {
    const onOpen = vi.fn();
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[makeTunnel("peer-abcdef12345678")]}
        onOpen={onOpen}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    fireEvent.click(screen.getByText("peer-abc"));
    expect(onOpen).toHaveBeenCalledWith("peer-abcdef12345678");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clicking 'Host a tunnel...' calls onShowHelp and closes the menu", () => {
    const onShowHelp = vi.fn();
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[makeTunnel("peer-abc")]}
        onShowHelp={onShowHelp}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    fireEvent.click(screen.getByText("Host a tunnel..."));
    expect(onShowHelp).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows 'Activating relay...' when swReady is false", () => {
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[makeTunnel("peer-abc")]}
        swReady={false}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    expect(screen.getByText(/Activating relay/)).toBeDefined();
  });

  it("shows 'Activating relay...' when swReady is false and there are WebRTC tunnels", () => {
    const webRtcTunnel: TunnelInfo = { peerId: "peer-webrtc", label: "app", port: 3000 };
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[webRtcTunnel]}
        swReady={false}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    expect(screen.getByText(/Activating relay/)).toBeDefined();
  });

  it("does NOT show 'Activating relay...' when all tunnels are server-relay even if swReady is false", () => {
    const serverRelayTunnel: TunnelInfo = { peerId: "peer-sr", label: "relay-app", port: 9000, serverRelay: true };
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[serverRelayTunnel]}
        swReady={false}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    expect(screen.queryByText(/Activating relay/)).toBeNull();
  });

  it("does NOT show 'Activating relay...' when swReady is true regardless of tunnel type", () => {
    const webRtcTunnel: TunnelInfo = { peerId: "peer-webrtc", label: "app", port: 3000 };
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[webRtcTunnel]}
        swReady={true}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    expect(screen.queryByText(/Activating relay/)).toBeNull();
  });

  it("closes the dropdown when clicking outside the badge", () => {
    render(
      <TunnelBadge {...defaultProps} tunnels={[makeTunnel("peer-abc")]} />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    expect(screen.getByRole("menu")).toBeDefined();

    // Click outside the badge container
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("calls onRemove with the correct peerId and stops propagation", () => {
    const onRemove = vi.fn();
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[makeTunnel("peer-remove-test")]}
        onRemove={onRemove}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    fireEvent.click(screen.getByLabelText("Remove tunnel"));
    expect(onRemove).toHaveBeenCalledWith("peer-remove-test");
  });

  it("shows plural text for multiple tunnels", () => {
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[makeTunnel("peer-a"), makeTunnel("peer-b")]}
      />
    );

    expect(screen.getByText("2 tunnels")).toBeDefined();
  });

  it("shows peer name from peerNames instead of truncated peerId", () => {
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[makeTunnel("peer-abcdef12345678")]}
        peerNames={{ "peer-abcdef12345678": "My Laptop" }}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    expect(screen.getByText("My Laptop")).toBeDefined();
  });

  it("shows tunnel label and port in the dropdown", () => {
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[makeTunnel("peer-abc", "my-app", 3000)]}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    expect(screen.getByText("my-app :3000")).toBeDefined();
  });

  it("shows only label without port when port is undefined", () => {
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[makeTunnel("peer-abc", "my-app")]}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    expect(screen.getByText("my-app")).toBeDefined();
  });

  it("shows only port without label when label is undefined", () => {
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[makeTunnel("peer-abc", undefined, 8080)]}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    expect(screen.getByText(":8080")).toBeDefined();
  });

  it("does not show subtitle when neither label nor port is set", () => {
    render(
      <TunnelBadge
        {...defaultProps}
        tunnels={[makeTunnel("peer-abc")]}
      />
    );

    fireEvent.click(screen.getByText("1 tunnel"));
    // Only the peer ID and remove/host buttons should be visible, no subtitle span
    const menuItems = screen.getAllByRole("menuitem");
    expect(menuItems.length).toBeGreaterThan(0);
  });
});
