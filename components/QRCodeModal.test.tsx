// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let QRCodeModal: typeof import("./QRCodeModal").QRCodeModal;

beforeAll(async () => {
  ({ QRCodeModal } = await import("./QRCodeModal"));
});

afterEach(() => {
  cleanup();
});

describe("QRCodeModal", () => {
  test("renders nothing while closed", () => {
    const view = render(
      <QRCodeModal open={false} onClose={() => undefined} url="https://example.com/demo" />
    );

    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("renders the QR code and closes on escape", async () => {
    const onClose = vi.fn();
    const view = render(
      <QRCodeModal open={true} onClose={onClose} url="https://example.com/demo" />
    );

    expect(view.getByLabelText("Loading QR code")).toBeTruthy();
    expect(view.getByRole("dialog")).toBeTruthy();
    await view.findByText("https://example.com/demo");
    await waitFor(() => expect(view.container.querySelector("svg")).toBeTruthy());

    fireEvent.keyDown(view.getByRole("dialog").parentElement as HTMLElement, {
      key: "Escape",
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    const view = render(
      <QRCodeModal open={true} onClose={onClose} url="https://example.com/demo" />
    );

    await view.findByText("https://example.com/demo");
    fireEvent.click(view.getByRole("dialog").parentElement as HTMLElement);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("does not close when clicking inside the dialog and closes from the X button", async () => {
    const onClose = vi.fn();
    const view = render(
      <QRCodeModal open={true} onClose={onClose} url="https://example.com/demo" />
    );

    await view.findByText("https://example.com/demo");
    fireEvent.click(view.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("copies URL to clipboard on button click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const view = render(
      <QRCodeModal open={true} onClose={() => undefined} url="https://example.com/demo" />
    );

    // The URL text appears in the button immediately, regardless of QR load state
    const urlButton = view.getByTitle("Click to copy URL");

    await act(async () => {
      fireEvent.click(urlButton);
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("https://example.com/demo");
    await waitFor(() => {
      expect(view.getByText("Copied to clipboard!")).toBeTruthy();
    });
  });

  test("handles clipboard write failure silently", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const view = render(
      <QRCodeModal open={true} onClose={() => undefined} url="https://example.com/demo" />
    );

    const urlButton = view.getByTitle("Click to copy URL");

    await act(async () => {
      fireEvent.click(urlButton);
      await Promise.resolve();
    });

    // No crash, URL still displayed
    expect(view.getByText("https://example.com/demo")).toBeTruthy();
  });

  test("does not trap focus when no focusable elements exist", () => {
    const onClose = vi.fn();
    const view = render(
      <QRCodeModal open={true} onClose={onClose} url="https://example.com/demo" />
    );

    const dialog = view.getByRole("dialog");

    // Remove all buttons so querySelectorAll returns empty
    const buttons = dialog.querySelectorAll("button");
    buttons.forEach((b) => b.remove());

    const backdrop = dialog.parentElement as HTMLElement;
    fireEvent.keyDown(backdrop, { key: "Tab" });
    // No error — just a no-op
  });

  test("traps focus between the first and last focusable controls", async () => {
    const onClose = vi.fn();
    const view = render(
      <QRCodeModal open={true} onClose={onClose} url="https://example.com/demo" />
    );

    await view.findByText("https://example.com/demo");
    await waitFor(() => expect(view.container.querySelector("svg")).toBeTruthy());

    const backdrop = view.getByRole("dialog").parentElement as HTMLElement;
    const buttons = view.getAllByRole("button");
    const closeButton = buttons[0];
    const urlButton = buttons[1];

    closeButton.focus();
    fireEvent.keyDown(backdrop, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(urlButton);

    urlButton.focus();
    fireEvent.keyDown(backdrop, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(backdrop, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
