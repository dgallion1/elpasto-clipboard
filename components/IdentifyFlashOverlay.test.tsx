// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

let IdentifyFlashOverlay: typeof import("./IdentifyFlashOverlay").IdentifyFlashOverlay;

beforeAll(async () => {
  ({ IdentifyFlashOverlay } = await import("./IdentifyFlashOverlay"));
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("IdentifyFlashOverlay", () => {
  test("restarts the flash for back-to-back identify pings", () => {
    const onDone = vi.fn();
    const peerNames = { "peer-12345678": "Kitchen iPad" };
    const view = render(
      <IdentifyFlashOverlay
        flash={{ id: 1, fromPeerId: "peer-12345678" }}
        peerNames={peerNames}
        onDone={onDone}
      />
    );

    const firstOverlayNode = view.container.firstChild;
    expect(view.getByText("Pinged by Kitchen iPad")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    view.rerender(
      <IdentifyFlashOverlay
        flash={{ id: 2, fromPeerId: "peer-12345678" }}
        peerNames={peerNames}
        onDone={onDone}
      />
    );

    expect(view.container.firstChild).not.toBe(firstOverlayNode);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onDone).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onDone).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(2);
  });

  test("renders nothing when flash is null", () => {
    const onDone = vi.fn();
    const view = render(
      <IdentifyFlashOverlay flash={null} peerNames={{}} onDone={onDone} />
    );
    expect(view.container.firstChild).toBeNull();
  });

  test("uses truncated peerId when peerNames does not contain the peer", () => {
    const onDone = vi.fn();
    const view = render(
      <IdentifyFlashOverlay
        flash={{ id: 1, fromPeerId: "abcdefgh12345678" }}
        peerNames={{}}
        onDone={onDone}
      />
    );
    expect(view.getByText("Pinged by abcdefgh")).toBeTruthy();
  });
});
