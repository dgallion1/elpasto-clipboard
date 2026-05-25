// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SoundDropdown } from "./SoundDropdown";

const defaultProps = {
  enabled: true,
  soundName: "droplet" as const,
  volume: "medium" as const,
  onSetEnabled: vi.fn(),
  onSetSoundName: vi.fn(),
  onCycleVolume: vi.fn(),
};

beforeEach(() => {
  defaultProps.onSetEnabled.mockReset();
  defaultProps.onSetSoundName.mockReset();
  defaultProps.onCycleVolume.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SoundDropdown", () => {
  test("trigger opens and closes the dropdown", () => {
    const view = render(<SoundDropdown {...defaultProps} />);
    const trigger = view.getByRole("button", { name: "Notification sound settings" });

    expect(view.queryByRole("dialog", { name: "Notification sound settings" })).toBeNull();

    fireEvent.click(trigger);
    expect(view.getByRole("dialog", { name: "Notification sound settings" })).toBeTruthy();

    fireEvent.click(trigger);
    expect(view.queryByRole("dialog", { name: "Notification sound settings" })).toBeNull();
  });

  test("renders all sound options", () => {
    const view = render(<SoundDropdown {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "Notification sound settings" }));

    expect(view.getByRole("button", { name: "Droplet" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Chirp" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Duo" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Bell" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Brush" })).toBeTruthy();
  });

  test("clicking a sound calls onSetSoundName", () => {
    const view = render(<SoundDropdown {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "Notification sound settings" }));
    fireEvent.click(view.getByRole("button", { name: "Bell" }));

    expect(defaultProps.onSetSoundName).toHaveBeenCalledWith("bell");
  });

  test("clicking the volume row calls onCycleVolume", () => {
    const view = render(<SoundDropdown {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "Notification sound settings" }));
    fireEvent.click(view.getByRole("button", { name: /medium/i }));

    expect(defaultProps.onCycleVolume).toHaveBeenCalledTimes(1);
  });

  test("toggle switch calls onSetEnabled", () => {
    const view = render(<SoundDropdown {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "Notification sound settings" }));
    fireEvent.click(view.getByRole("switch", { name: "Sound" }));

    expect(defaultProps.onSetEnabled).toHaveBeenCalledWith(false);
  });

  test("outside click closes the dropdown", () => {
    const view = render(<SoundDropdown {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "Notification sound settings" }));

    fireEvent.mouseDown(document.body);

    expect(view.queryByRole("dialog", { name: "Notification sound settings" })).toBeNull();
  });

  test("sound buttons remain present and clickable when disabled", () => {
    const props = { ...defaultProps, enabled: false };
    const view = render(<SoundDropdown {...props} />);
    fireEvent.click(view.getByRole("button", { name: "Notification sound settings" }));

    const bellButton = view.getByRole("button", { name: "Bell" });
    expect(bellButton).toBeTruthy();

    fireEvent.click(bellButton);
    expect(props.onSetSoundName).toHaveBeenCalledWith("bell");

    fireEvent.click(view.getByRole("button", { name: /low|medium|high/i }));
    expect(props.onCycleVolume).toHaveBeenCalledTimes(1);
  });

  test("escape closes the dropdown and returns focus to the trigger", () => {
    const view = render(<SoundDropdown {...defaultProps} />);
    const trigger = view.getByRole("button", { name: "Notification sound settings" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(view.queryByRole("dialog", { name: "Notification sound settings" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
