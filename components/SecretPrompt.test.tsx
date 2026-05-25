// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const generateUnlockSecretMock = vi.fn(() => "generated-secret");
const normalizeUnlockSecretMock = vi.fn((secret: string) => secret.trim());
const isStrongUnlockSecretMock = vi.fn((secret: string) => secret.length >= 12);
const writeTextMock = vi.fn(() => Promise.resolve());

vi.mock("@/lib/clip-crypto", () => ({
  generateUnlockSecret: generateUnlockSecretMock,
  normalizeUnlockSecret: normalizeUnlockSecretMock,
  isStrongUnlockSecret: isStrongUnlockSecretMock,
}));

let SecretPrompt: typeof import("./SecretPrompt").SecretPrompt;

beforeAll(async () => {
  ({ SecretPrompt } = await import("./SecretPrompt"));
});

beforeEach(() => {
  vi.useFakeTimers();
  generateUnlockSecretMock.mockClear();
  normalizeUnlockSecretMock.mockClear();
  isStrongUnlockSecretMock.mockClear();
  writeTextMock.mockReset();
  writeTextMock.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeTextMock },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SecretPrompt", () => {
  test("renders nothing when closed", () => {
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret={null}
        mode="setup"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
        open={false}
      />
    );

    expect(view.container.firstChild).toBeNull();
  });

  test("uses a generated secret in setup mode and validates empty or weak submissions", () => {
    const onSubmit = vi.fn();
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret={null}
        mode="setup"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={onSubmit}
        open
      />
    );

    const input = view.getByPlaceholderText("Generate one or enter a strong passphrase") as HTMLInputElement;
    expect(input.value).toBe("generated-secret");

    // Generate Secret now fills the field, does not auto-submit
    generateUnlockSecretMock.mockReturnValueOnce("new-generated");
    fireEvent.click(view.getByRole("button", { name: "Generate Secret" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe("new-generated");

    fireEvent.click(view.getByRole("button", { name: "Clear" }));
    fireEvent.click(view.getByRole("button", { name: "Use Secret" }));
    expect(view.getByRole("alert").textContent).toContain("Enter a secret");

    fireEvent.change(input, { target: { value: "short" } });
    fireEvent.click(view.getByRole("button", { name: "Use Secret" }));
    expect(view.getByRole("alert").textContent).toContain("Use at least 12 characters");

    fireEvent.change(input, { target: { value: "  valid-secret  " } });
    fireEvent.click(view.getByRole("button", { name: "Use Secret" }));
    expect(onSubmit).toHaveBeenCalledWith("valid-secret");
  });

  test("supports manage mode actions including copy, clear, forget, cancel, and focus trap", async () => {
    const onCancel = vi.fn();
    const onClear = vi.fn();
    const onSubmit = vi.fn();
    const view = render(
      <SecretPrompt
        canClear
        initialSecret="saved-secret"
        mode="manage"
        onCancel={onCancel}
        onClear={onClear}
        onSubmit={onSubmit}
        open
      />
    );

    const input = view.getByDisplayValue("saved-secret") as HTMLInputElement;
    const overlay = view.getByRole("dialog", { name: "Manage Secret" }).parentElement!;
    const cancelButton = view.getByRole("button", { name: "Cancel" });

    fireEvent.click(view.getByRole("button", { name: "Copy secret" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalledWith("saved-secret");
    vi.advanceTimersByTime(1600);

    fireEvent.change(input, { target: { value: "replacement-secret" } });
    fireEvent.click(view.getByRole("button", { name: "Use Secret" }));
    expect(onSubmit).toHaveBeenCalledWith("replacement-secret");

    fireEvent.click(view.getByRole("button", { name: "Forget Secret" }));
    expect(onClear).toHaveBeenCalledTimes(1);

    input.focus();
    fireEvent.keyDown(overlay, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancelButton);

    cancelButton.focus();
    fireEvent.keyDown(overlay, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(overlay, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("in setup mode with existing initialSecret, uses it as draft instead of generating", () => {
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret="existing-secret"
        mode="setup"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
        open
      />
    );

    const input = view.getByDisplayValue("existing-secret") as HTMLInputElement;
    expect(input.value).toBe("existing-secret");
    // generateUnlockSecret should NOT have been called
    expect(generateUnlockSecretMock).not.toHaveBeenCalled();
  });

  test("Tab key on non-Tab key does not trap focus", () => {
    const onCancel = vi.fn();
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret={null}
        mode="setup"
        onCancel={onCancel}
        onClear={() => undefined}
        onSubmit={() => undefined}
        open
      />
    );

    const overlay = view.getByRole("dialog", { name: "Set Up Encryption" }).parentElement!;

    // Tab should not call onCancel
    fireEvent.keyDown(overlay, { key: "Tab" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  test("Tab forward from last focusable wraps to first", () => {
    const view = render(
      <SecretPrompt
        canClear
        initialSecret="saved-secret"
        mode="manage"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
        open
      />
    );

    const overlay = view.getByRole("dialog", { name: "Manage Secret" }).parentElement!;
    const cancelButton = view.getByRole("button", { name: "Cancel" });
    const input = view.getByDisplayValue("saved-secret") as HTMLInputElement;

    // Focus the last element (Cancel button)
    cancelButton.focus();
    expect(document.activeElement).toBe(cancelButton);

    // Tab forward from last should wrap to first
    fireEvent.keyDown(overlay, { key: "Tab" });
    expect(document.activeElement).toBe(input);
  });

  test("resets error state when input changes", () => {
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret={null}
        mode="required"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
        open
      />
    );

    const input = view.getByPlaceholderText("Generate one or enter a strong passphrase") as HTMLInputElement;

    // Submit empty to trigger error
    fireEvent.click(view.getByRole("button", { name: "Use Secret" }));
    expect(view.getByRole("alert")).toBeTruthy();

    // Typing should clear the error
    fireEvent.change(input, { target: { value: "t" } });
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("Generate Secret fills the field without submitting", () => {
    const onSubmit = vi.fn();
    generateUnlockSecretMock.mockReturnValue("fill-only-secret");
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret={null}
        mode="required"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={onSubmit}
        open
      />
    );

    const input = view.getByPlaceholderText("Generate one or enter a strong passphrase") as HTMLInputElement;
    fireEvent.click(view.getByRole("button", { name: "Generate Secret" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe("fill-only-secret");
  });

  test("forget-passphrase checkbox routes to onSubmitParanoid", () => {
    const onSubmit = vi.fn();
    const onSubmitParanoid = vi.fn();
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret={null}
        mode="setup"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={onSubmit}
        onSubmitParanoid={onSubmitParanoid}
        paranoidAvailable
        open
      />
    );

    const input = view.getByPlaceholderText("Generate one or enter a strong passphrase") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a-strong-passphrase" } });
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Use Secret" }));
    expect(onSubmitParanoid).toHaveBeenCalledWith("a-strong-passphrase");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("forget-passphrase checkbox is hidden when paranoidAvailable is false", () => {
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret={null}
        mode="setup"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
        onSubmitParanoid={() => undefined}
        paranoidAvailable={false}
        open
      />
    );

    expect(view.queryByRole("checkbox")).toBeNull();
  });

  test("forget-passphrase checkbox is hidden in required mode", () => {
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret={null}
        mode="required"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
        onSubmitParanoid={() => undefined}
        paranoidAvailable
        open
      />
    );

    expect(view.queryByRole("checkbox")).toBeNull();
  });

  test("forget-passphrase checked validates empty secret", () => {
    const onSubmitParanoid = vi.fn();
    normalizeUnlockSecretMock.mockReturnValueOnce("");
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret={null}
        mode="setup"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
        onSubmitParanoid={onSubmitParanoid}
        paranoidAvailable
        open
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Clear" }));
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Use Secret" }));
    expect(view.getByRole("alert").textContent).toContain("Enter a secret");
    expect(onSubmitParanoid).not.toHaveBeenCalled();
  });

  test("forget-passphrase checked validates weak secret", () => {
    const onSubmitParanoid = vi.fn();
    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret={null}
        mode="setup"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
        onSubmitParanoid={onSubmitParanoid}
        paranoidAvailable
        open
      />
    );

    const input = view.getByPlaceholderText("Generate one or enter a strong passphrase") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "short" } });
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Use Secret" }));
    expect(view.getByRole("alert").textContent).toContain("Use at least 12 characters");
    expect(onSubmitParanoid).not.toHaveBeenCalled();
  });

  test("ignores clipboard copy failures and reuses initial secret outside setup mode", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("denied"));

    const view = render(
      <SecretPrompt
        canClear={false}
        initialSecret="shared-secret"
        mode="required"
        onCancel={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
        open
      />
    );

    expect(view.getByRole("dialog", { name: "Enter Unlock Secret" })).toBeTruthy();
    expect(view.getByDisplayValue("shared-secret")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Copy secret" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalledWith("shared-secret");
  });
});
