// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DeviceHandoff } from "./DeviceHandoff";

afterEach(() => cleanup());
beforeEach(() => sessionStorage.clear());

const url = "https://elpasto.app/elk-piano-river";

describe("DeviceHandoff", () => {
  test("renders the center panel when empty and waiting", () => {
    const view = render(
      <DeviceHandoff state="waiting" sessionUrl={url} token="elk-piano-river" hasClips={false} />
    );
    expect(view.getByText("Scan to link your phone")).toBeTruthy();
    expect(view.getByText("Waiting for your other device…")).toBeTruthy();
  });

  test("swaps to connecting copy in the panel", () => {
    const view = render(
      <DeviceHandoff state="connecting" sessionUrl={url} token="elk-piano-river" hasClips={false} />
    );
    expect(view.getByText("Device connecting…")).toBeTruthy();
  });

  test("renders the slim banner when clips exist", () => {
    const view = render(
      <DeviceHandoff state="waiting" sessionUrl={url} token="elk-piano-river" hasClips={true} />
    );
    expect(view.getByText("No device linked yet")).toBeTruthy();
    expect(view.queryByText("Scan to link your phone")).toBeNull();
  });

  test("dismissing the banner hides it and persists to sessionStorage", () => {
    const view = render(
      <DeviceHandoff state="waiting" sessionUrl={url} token="elk-piano-river" hasClips={true} />
    );
    fireEvent.click(view.getByLabelText("Dismiss"));
    expect(view.queryByText("No device linked yet")).toBeNull();
    expect(sessionStorage.getItem("elpasto:handoff-dismissed:elk-piano-river")).toBe("1");
  });

  test("stays hidden after dismiss even when the thread later empties", () => {
    const view = render(
      <DeviceHandoff state="waiting" sessionUrl={url} token="elk-piano-river" hasClips={true} />
    );
    fireEvent.click(view.getByLabelText("Dismiss"));
    view.rerender(
      <DeviceHandoff state="waiting" sessionUrl={url} token="elk-piano-river" hasClips={false} />
    );
    expect(view.queryByText("No device linked yet")).toBeNull();
    expect(view.queryByText("Scan to link your phone")).toBeNull();
  });

  test("stays hidden on mount when already dismissed for this token", () => {
    sessionStorage.setItem("elpasto:handoff-dismissed:elk-piano-river", "1");
    const view = render(
      <DeviceHandoff state="waiting" sessionUrl={url} token="elk-piano-river" hasClips={true} />
    );
    expect(view.queryByText("No device linked yet")).toBeNull();
  });

  test("renders nothing once connected", () => {
    const view = render(
      <DeviceHandoff state="connected-direct" sessionUrl={url} token="elk-piano-river" hasClips={false} />
    );
    expect(view.container.firstChild).toBeNull();
  });
});
