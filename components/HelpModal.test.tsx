// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { HelpModal } from "./HelpModal";

afterEach(() => {
  cleanup();
});

describe("HelpModal", () => {
  test("renders nothing when closed", () => {
    const view = render(<HelpModal open={false} onClose={() => undefined} />);
    expect(view.container.firstChild).toBeNull();
  });

  test("toggles technical details and closes on backdrop or escape", () => {
    const onClose = vi.fn();
    const view = render(<HelpModal open onClose={onClose} />);

    const dialog = view.getByRole("dialog", { name: "How elPasto works" });
    // Technical details should be collapsed initially
    expect(view.queryByText(/Sessions are identified by a 5-word token/)).toBeNull();

    fireEvent.click(view.getAllByText("Technical details")[0]);
    expect(view.getByText(/Sessions are identified by a 5-word token/)).toBeTruthy();

    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(dialog.parentElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });


  test("traps focus with tab navigation", () => {
    const view = render(<HelpModal open onClose={() => undefined} />);

    fireEvent.click(view.getAllByRole("button", { name: "Technical details" })[0]);

    const closeButton = view.getByRole("button", { name: "Close" });
    const lastButton = view.getByRole("button", { name: "Got it" });
    closeButton.focus();
    fireEvent.keyDown(closeButton.closest("div.fixed")!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(lastButton);

    lastButton.focus();
    fireEvent.keyDown(lastButton.closest("div.fixed")!, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
  });


  test("Tab key in middle of focusable elements does not trap focus", () => {
    const view = render(<HelpModal open onClose={() => undefined} />);

    // Expand technical details so there are intermediate buttons
    fireEvent.click(view.getAllByRole("button", { name: "Technical details" })[0]);

    const closeButton = view.getByRole("button", { name: "Close" });
    const backdrop = closeButton.closest("div.fixed")!;

    // Focus a middle button (not first or last) and press Tab — should not trap
    const allButtons = view.getAllByRole("button");
    const middleButton = allButtons[Math.floor(allButtons.length / 2)];
    middleButton.focus();
    fireEvent.keyDown(backdrop, { key: "Tab" });
    // Focus should NOT have jumped to first — normal Tab behavior
    // (We verify it didn't wrap to first or last, since the button is in the middle)
    expect(document.activeElement).toBe(middleButton);
  });

  test("non-Tab/non-Escape key does nothing special", () => {
    const onClose = vi.fn();
    const view = render(<HelpModal open onClose={onClose} />);

    const backdrop = view.getByRole("dialog").parentElement!;
    fireEvent.keyDown(backdrop, { key: "a" });

    expect(onClose).not.toHaveBeenCalled();
  });

});
