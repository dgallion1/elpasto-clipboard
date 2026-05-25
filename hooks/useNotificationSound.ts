import { useCallback, useRef, useSyncExternalStore } from "react";

const ENABLED_STORAGE_KEY = "elpasto:sound-enabled";
const NAME_STORAGE_KEY = "elpasto:sound-name";
const VOLUME_STORAGE_KEY = "elpasto:sound-volume";
const STORAGE_KEYS = new Set([
  ENABLED_STORAGE_KEY,
  NAME_STORAGE_KEY,
  VOLUME_STORAGE_KEY,
]);
const DEBOUNCE_MS = 500;

export type SoundName = "droplet" | "chirp" | "duo" | "bell" | "brush";
export type SoundVolume = "low" | "medium" | "high";
export type SoundSynth = (ctx: AudioContext, gain: number) => void;

export interface NotificationSoundState {
  enabled: boolean;
  soundName: SoundName;
  volume: SoundVolume;
}

export const SOUND_OPTIONS: Array<{ name: SoundName; label: string }> = [
  { name: "droplet", label: "Droplet" },
  { name: "chirp", label: "Chirp" },
  { name: "duo", label: "Duo" },
  { name: "bell", label: "Bell" },
  { name: "brush", label: "Brush" },
];

export const VOLUME_GAINS: Record<SoundVolume, number> = {
  low: 0.15,
  medium: 0.4,
  high: 0.8,
};

const VOLUME_ORDER: SoundVolume[] = ["low", "medium", "high"];

const DEFAULT_SOUND_STATE: NotificationSoundState = {
  enabled: false,
  soundName: "droplet",
  volume: "medium",
};

function isSoundName(value: string | null): value is SoundName {
  return SOUND_OPTIONS.some((option) => option.name === value);
}

function isSoundVolume(value: string | null): value is SoundVolume {
  return VOLUME_ORDER.includes(value as SoundVolume);
}

function sameSoundState(a: NotificationSoundState, b: NotificationSoundState) {
  return a.enabled === b.enabled && a.soundName === b.soundName && a.volume === b.volume;
}

function createTonePulse(
  ctx: AudioContext,
  {
    startAt,
    duration,
    frequency,
    toFrequency,
    gain,
    type = "sine",
  }: {
    startAt: number;
    duration: number;
    frequency: number;
    toFrequency?: number;
    gain: number;
    type?: OscillatorType;
  }
) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startAt);
  if (toFrequency && toFrequency !== frequency) {
    osc.frequency.exponentialRampToValueAtTime(toFrequency, startAt + duration);
  }
  amp.gain.setValueAtTime(Math.max(gain, 0.001), startAt);
  amp.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
  osc.connect(amp);
  amp.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

function createBellTone(ctx: AudioContext, frequency: number, gain: number, startAt: number, duration: number) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency, startAt);
  amp.gain.setValueAtTime(Math.max(gain, 0.001), startAt);
  amp.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
  osc.connect(amp);
  amp.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

function createNoiseBuffer(ctx: AudioContext, durationMs: number) {
  const frameCount = Math.max(1, Math.floor((ctx.sampleRate * durationMs) / 1000));
  const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < channel.length; index += 1) {
    channel[index] = Math.random() * 2 - 1;
  }
  return buffer;
}

function createBrushHit(
  ctx: AudioContext,
  buffer: AudioBuffer,
  gain: number,
  startAt: number
) {
  const noise = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const noiseGain = ctx.createGain();
  const thump = ctx.createOscillator();
  const thumpGain = ctx.createGain();

  filter.type = "bandpass";
  filter.frequency.setValueAtTime(900, startAt);
  filter.Q.setValueAtTime(0.7, startAt);

  noise.buffer = buffer;
  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(ctx.destination);
  noiseGain.gain.setValueAtTime(Math.max(gain * 0.45, 0.001), startAt);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.08);

  thump.type = "sine";
  thump.frequency.setValueAtTime(200, startAt);
  thump.connect(thumpGain);
  thumpGain.connect(ctx.destination);
  thumpGain.gain.setValueAtTime(Math.max(gain * 0.55, 0.001), startAt);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.1);

  noise.start(startAt);
  noise.stop(startAt + 0.1);
  thump.start(startAt);
  thump.stop(startAt + 0.1);
}

export const SOUNDS: Record<SoundName, SoundSynth> = {
  droplet: (ctx, gain) => {
    createTonePulse(ctx, {
      startAt: ctx.currentTime,
      duration: 0.2,
      frequency: 880,
      toFrequency: 440,
      gain,
    });
  },
  chirp: (ctx, gain) => {
    createTonePulse(ctx, {
      startAt: ctx.currentTime,
      duration: 0.12,
      frequency: 400,
      toFrequency: 900,
      gain,
    });
  },
  duo: (ctx, gain) => {
    createTonePulse(ctx, {
      startAt: ctx.currentTime,
      duration: 0.06,
      frequency: 660,
      gain,
    });
    createTonePulse(ctx, {
      startAt: ctx.currentTime + 0.14,
      duration: 0.06,
      frequency: 660,
      gain,
    });
  },
  bell: (ctx, gain) => {
    createBellTone(ctx, 1200, gain, ctx.currentTime, 0.3);
    createBellTone(ctx, 2400, gain * 0.45, ctx.currentTime, 0.3);
  },
  brush: (ctx, gain) => {
    if (!cachedNoiseBuffer || cachedNoiseBuffer.sampleRate !== ctx.sampleRate) {
      cachedNoiseBuffer = createNoiseBuffer(ctx, 250);
    }
    createBrushHit(ctx, cachedNoiseBuffer, gain, ctx.currentTime);
    createBrushHit(ctx, cachedNoiseBuffer, gain, ctx.currentTime + 0.1);
  },
};

let listeners = new Set<() => void>();
let audioCtx: AudioContext | null = null;
let cachedNoiseBuffer: AudioBuffer | null = null;
let currentSnapshot: NotificationSoundState = DEFAULT_SOUND_STATE;
let storageListenerAttached = false;

function readStoredSoundState(): NotificationSoundState | null {
  try {
    const soundName = localStorage.getItem(NAME_STORAGE_KEY);
    const volume = localStorage.getItem(VOLUME_STORAGE_KEY);
    return {
      enabled: localStorage.getItem(ENABLED_STORAGE_KEY) === "true",
      soundName: isSoundName(soundName) ? soundName : DEFAULT_SOUND_STATE.soundName,
      volume: isSoundVolume(volume) ? volume : DEFAULT_SOUND_STATE.volume,
    };
  } catch {
    return null;
  }
}

function getSnapshot() {
  const stored = readStoredSoundState();
  if (stored && !sameSoundState(stored, currentSnapshot)) {
    currentSnapshot = stored;
  }
  return currentSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_SOUND_STATE;
}

function notifyListeners() {
  for (const callback of listeners) {
    callback();
  }
}

function commitSnapshot(next: NotificationSoundState) {
  const changed = !sameSoundState(next, currentSnapshot);
  currentSnapshot = next;
  if (changed) {
    notifyListeners();
  }
}

function setStoredEnabled(enabled: boolean) {
  try {
    if (enabled) {
      localStorage.setItem(ENABLED_STORAGE_KEY, "true");
    } else {
      localStorage.removeItem(ENABLED_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable
  }
}

function setStoredSoundName(soundName: SoundName) {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, soundName);
  } catch {
    // localStorage unavailable
  }
}

function setStoredVolume(volume: SoundVolume) {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, volume);
  } catch {
    // localStorage unavailable
  }
}

function handleStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== localStorage) {
    return;
  }
  // key === null means localStorage.clear() — re-read to pick up the reset
  if (event.key !== null && !STORAGE_KEYS.has(event.key)) {
    return;
  }
  const stored = readStoredSoundState();
  if (stored && !sameSoundState(stored, currentSnapshot)) {
    currentSnapshot = stored;
    notifyListeners();
  }
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  if (!storageListenerAttached && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
    storageListenerAttached = true;
  }
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && storageListenerAttached && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
      storageListenerAttached = false;
    }
  };
}

function getAudioContext() {
  if (audioCtx) {
    return audioCtx;
  }

  const g = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextConstructor = g.AudioContext ?? g.webkitAudioContext;

  if (!AudioContextConstructor) {
    return null;
  }

  audioCtx = new AudioContextConstructor();
  return audioCtx;
}

function playSoundNow(state: NotificationSoundState) {
  if (!state.enabled) {
    return;
  }

  try {
    const ctx = getAudioContext();
    if (!ctx) {
      return;
    }
    const maybeResume = ctx.resume?.();
    if (maybeResume && typeof maybeResume.catch === "function") {
      void maybeResume.catch(() => {});
    }
    SOUNDS[state.soundName](ctx, VOLUME_GAINS[state.volume]);
  } catch {
    // Web Audio unavailable
  }
}

function nextVolume(current: SoundVolume): SoundVolume {
  const index = VOLUME_ORDER.indexOf(current);
  return VOLUME_ORDER[(index + 1) % VOLUME_ORDER.length];
}

export function resetNotificationSoundForTests() {
  listeners.clear();
  if (storageListenerAttached && typeof window !== "undefined") {
    window.removeEventListener("storage", handleStorage);
  }
  storageListenerAttached = false;
  if (audioCtx) {
    try { audioCtx.close(); } catch { /* already closed */ }
  }
  audioCtx = null;
  cachedNoiseBuffer = null;
  currentSnapshot = DEFAULT_SOUND_STATE;
}

export function useNotificationSound() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const lastPlayRef = useRef(0);

  const play = useCallback(() => {
    const current = getSnapshot();
    if (!current.enabled) {
      return;
    }

    const now = Date.now();
    if (now - lastPlayRef.current < DEBOUNCE_MS) {
      return;
    }

    lastPlayRef.current = now;
    playSoundNow(current);
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    const previous = getSnapshot();
    if (previous.enabled === enabled) {
      return;
    }

    const next = {
      ...previous,
      enabled,
    };
    setStoredEnabled(enabled);
    commitSnapshot(next);
    if (enabled) {
      playSoundNow(next);
    }
  }, []);

  const setSoundName = useCallback((soundName: SoundName) => {
    const previous = getSnapshot();
    const next = {
      ...previous,
      enabled: true,
      soundName,
    };
    setStoredEnabled(true);
    setStoredSoundName(soundName);
    commitSnapshot(next);
    playSoundNow(next);
  }, []);

  const cycleVolume = useCallback(() => {
    const previous = getSnapshot();
    const volume = nextVolume(previous.volume);
    const next = {
      ...previous,
      enabled: true,
      volume,
    };
    setStoredEnabled(true);
    setStoredVolume(volume);
    commitSnapshot(next);
    playSoundNow(next);
  }, []);

  return {
    enabled: snapshot.enabled,
    soundName: snapshot.soundName,
    volume: snapshot.volume,
    play,
    setEnabled,
    setSoundName,
    cycleVolume,
  };
}
