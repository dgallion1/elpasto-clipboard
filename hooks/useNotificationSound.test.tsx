// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  SOUNDS,
  resetNotificationSoundForTests,
  useNotificationSound,
} from "./useNotificationSound";

class MockAudioParam {
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class MockAudioNode {
  connect = vi.fn();
}

class MockOscillatorNode extends MockAudioNode {
  type = "sine";
  frequency = new MockAudioParam();
  start = vi.fn();
  stop = vi.fn();
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam();
}

class MockBiquadFilterNode extends MockAudioNode {
  type = "bandpass";
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
}

class MockBufferSourceNode extends MockAudioNode {
  buffer: AudioBuffer | null = null;
  start = vi.fn();
  stop = vi.fn();
}

class MockAudioBuffer {
  constructor(private readonly length: number) {}

  getChannelData() {
    return new Float32Array(this.length);
  }
}

class MockAudioContext {
  currentTime = 0;
  destination = {};
  sampleRate = 44100;

  createOscillator() {
    return new MockOscillatorNode();
  }

  createGain() {
    return new MockGainNode();
  }

  createBiquadFilter() {
    return new MockBiquadFilterNode();
  }

  createBuffer(_channels: number, length: number) {
    return new MockAudioBuffer(length);
  }

  createBufferSource() {
    return new MockBufferSourceNode();
  }

  resume() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
  resetNotificationSoundForTests();
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    writable: true,
    value: MockAudioContext,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetNotificationSoundForTests();
});

describe("useNotificationSound", () => {
  test("defaults to disabled droplet at medium volume", () => {
    const { result } = renderHook(() => useNotificationSound());

    expect(result.current.enabled).toBe(false);
    expect(result.current.soundName).toBe("droplet");
    expect(result.current.volume).toBe("medium");
  });

  test("setEnabled(true) persists the enabled flag", () => {
    const { result } = renderHook(() => useNotificationSound());

    act(() => {
      result.current.setEnabled(true);
    });

    expect(result.current.enabled).toBe(true);
    expect(window.localStorage.getItem("elpasto:sound-enabled")).toBe("true");
  });

  test("setSoundName persists the name and enables sound", () => {
    const { result } = renderHook(() => useNotificationSound());

    act(() => {
      result.current.setSoundName("bell");
    });

    expect(result.current.enabled).toBe(true);
    expect(result.current.soundName).toBe("bell");
    expect(window.localStorage.getItem("elpasto:sound-enabled")).toBe("true");
    expect(window.localStorage.getItem("elpasto:sound-name")).toBe("bell");
  });

  test("cycleVolume cycles low to medium to high to low and enables sound", () => {
    window.localStorage.setItem("elpasto:sound-volume", "low");
    const { result } = renderHook(() => useNotificationSound());

    act(() => {
      result.current.cycleVolume();
    });
    expect(result.current.enabled).toBe(true);
    expect(result.current.volume).toBe("medium");
    expect(window.localStorage.getItem("elpasto:sound-volume")).toBe("medium");

    act(() => {
      result.current.cycleVolume();
    });
    expect(result.current.volume).toBe("high");
    expect(window.localStorage.getItem("elpasto:sound-volume")).toBe("high");

    act(() => {
      result.current.cycleVolume();
    });
    expect(result.current.volume).toBe("low");
    expect(window.localStorage.getItem("elpasto:sound-volume")).toBe("low");
  });

  test("existing users with only the enabled flag keep droplet at medium volume", () => {
    window.localStorage.setItem("elpasto:sound-enabled", "true");

    const { result } = renderHook(() => useNotificationSound());

    expect(result.current.enabled).toBe(true);
    expect(result.current.soundName).toBe("droplet");
    expect(result.current.volume).toBe("medium");
  });

  test("storage events update subscribers", () => {
    const { result } = renderHook(() => useNotificationSound());

    act(() => {
      window.localStorage.setItem("elpasto:sound-enabled", "true");
      window.localStorage.setItem("elpasto:sound-name", "brush");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "elpasto:sound-name",
          newValue: "brush",
          storageArea: window.localStorage,
        })
      );
    });

    expect(result.current.enabled).toBe(true);
    expect(result.current.soundName).toBe("brush");
  });

  test("setEnabled(false) does not trigger playback", () => {
    const { result } = renderHook(() => useNotificationSound());

    act(() => {
      result.current.setEnabled(true);
    });
    expect(result.current.enabled).toBe(true);

    const spy = vi.spyOn(MockAudioContext.prototype, "createOscillator");
    spy.mockClear();

    act(() => {
      result.current.setEnabled(false);
    });

    expect(result.current.enabled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("preview setters and notification playback do not throw with AudioContext available", () => {
    const { result } = renderHook(() => useNotificationSound());

    expect(() => {
      act(() => {
        result.current.setEnabled(true);
        result.current.setSoundName("chirp");
        result.current.cycleVolume();
        result.current.play();
      });
    }).not.toThrow();
  });
});

describe("notification sound synthesis", () => {
  test.each(Object.entries(SOUNDS))("%s creates audio nodes without throwing", (_name, synth) => {
    const ctx = new MockAudioContext() as unknown as AudioContext;
    expect(() => synth(ctx, 0.15)).not.toThrow();
  });
});
