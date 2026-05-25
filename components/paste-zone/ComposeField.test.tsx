// @vitest-environment jsdom
import { act, cleanup, render, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposeField } from "./ComposeField";

afterEach(() => {
  cleanup();
});

describe("ComposeField", () => {
  test("pressing Enter with empty input prevents default and does not submit", () => {
    const onSubmitText = vi.fn();
    const view = render(
      <ComposeField zone="A" onSubmitText={onSubmitText} onPaste={vi.fn()} onFocusZone={vi.fn()} />,
    );

    const textarea = view.getByRole("textbox") as HTMLTextAreaElement;

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      textarea.dispatchEvent(event);
    });

    expect(onSubmitText).not.toHaveBeenCalled();
  });

  test("pressing Enter with whitespace-only input prevents default and does not submit", () => {
    const onSubmitText = vi.fn();
    const view = render(
      <ComposeField zone="A" onSubmitText={onSubmitText} onPaste={vi.fn()} onFocusZone={vi.fn()} />,
    );

    const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "   " } });

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      textarea.dispatchEvent(event);
    });

    expect(onSubmitText).not.toHaveBeenCalled();
  });

  test("pressing Enter with text submits and clears the field", () => {
    const onSubmitText = vi.fn();
    const view = render(
      <ComposeField zone="A" onSubmitText={onSubmitText} onPaste={vi.fn()} onFocusZone={vi.fn()} />,
    );

    const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello world" } });

    act(() => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });

    expect(onSubmitText).toHaveBeenCalledWith("hello world");
  });

  test("Shift+Enter does not submit", () => {
    const onSubmitText = vi.fn();
    const view = render(
      <ComposeField zone="A" onSubmitText={onSubmitText} onPaste={vi.fn()} onFocusZone={vi.fn()} />,
    );

    const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello" } });

    act(() => {
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    });

    expect(onSubmitText).not.toHaveBeenCalled();
  });

  test("Enter during IME composition does not submit", () => {
    const onSubmitText = vi.fn();
    const view = render(
      <ComposeField zone="A" onSubmitText={onSubmitText} onPaste={vi.fn()} onFocusZone={vi.fn()} />,
    );

    const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello" } });

    // Use a real DOM KeyboardEvent with isComposing: true
    // React reads nativeEvent.isComposing from the real DOM event
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    } as KeyboardEventInit);
    act(() => {
      textarea.dispatchEvent(event);
    });

    expect(onSubmitText).not.toHaveBeenCalled();
  });

  test("pressing a non-special key does not interfere with input", () => {
    const onSubmitText = vi.fn();
    const view = render(
      <ComposeField zone="A" onSubmitText={onSubmitText} onPaste={vi.fn()} onFocusZone={vi.fn()} />,
    );

    const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello" } });

    act(() => {
      fireEvent.keyDown(textarea, { key: "a" });
    });

    expect(onSubmitText).not.toHaveBeenCalled();
    expect(textarea.value).toBe("hello");
  });

  test("onPaste is called and propagation is stopped", () => {
    const onPaste = vi.fn();
    const view = render(
      <ComposeField zone="A" onSubmitText={vi.fn()} onPaste={onPaste} onFocusZone={vi.fn()} />,
    );

    const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { items: [], getData: () => "" },
    });

    act(() => {
      fireEvent.paste(textarea);
    });

    expect(onPaste).toHaveBeenCalled();
  });

  test("calls onFocusZone when textarea is focused", () => {
    const onFocusZone = vi.fn();
    const view = render(
      <ComposeField zone="B" onSubmitText={vi.fn()} onPaste={vi.fn()} onFocusZone={onFocusZone} />,
    );

    const textarea = view.getByRole("textbox");
    act(() => {
      fireEvent.focus(textarea);
    });

    expect(onFocusZone).toHaveBeenCalledWith("B");
  });
});
