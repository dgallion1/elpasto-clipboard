"use client";

import { useEffect, useRef, useState } from "react";
import {
  SOUND_OPTIONS,
  type SoundName,
  type SoundVolume,
} from "@/hooks/useNotificationSound";

interface SoundDropdownProps {
  enabled: boolean;
  soundName: SoundName;
  volume: SoundVolume;
  onSetEnabled: (enabled: boolean) => void;
  onSetSoundName: (name: SoundName) => void;
  onCycleVolume: () => void;
}

const VOLUME_DOTS: Record<SoundVolume, string> = {
  low: "●○○",
  medium: "●●○",
  high: "●●●",
};

function SpeakerIcon({ enabled }: { enabled: boolean }) {
  if (enabled) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
        <path d="M10 3.75a.75.75 0 0 0-1.264-.546L5.203 6H2.667a.75.75 0 0 0-.7.48A6.985 6.985 0 0 0 1.5 10c0 1.28.344 2.476.946 3.51a.75.75 0 0 0 .717.49h2.54l3.533 2.796A.75.75 0 0 0 10 16.25V3.75ZM15.95 5.05a.75.75 0 0 0-1.06 1.06 5.5 5.5 0 0 1 0 7.78.75.75 0 0 0 1.06 1.06 7 7 0 0 0 0-9.9Z" />
        <path d="M13.829 7.172a.75.75 0 0 0-1.061 1.06 2.5 2.5 0 0 1 0 3.536.75.75 0 0 0 1.06 1.06 4 4 0 0 0 0-5.656Z" />
      </svg>
    );
  }

  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M10 3.75a.75.75 0 0 0-1.264-.546L5.203 6H2.667a.75.75 0 0 0-.7.48A6.985 6.985 0 0 0 1.5 10c0 1.28.344 2.476.946 3.51a.75.75 0 0 0 .717.49h2.54l3.533 2.796A.75.75 0 0 0 10 16.25V3.75Z" />
      <path d="M14.22 7.22a.75.75 0 0 1 1.06 0L17 8.94l1.72-1.72a.75.75 0 0 1 1.06 1.06L18.06 10l1.72 1.72a.75.75 0 0 1-1.06 1.06L17 11.06l-1.72 1.72a.75.75 0 0 1-1.06-1.06L15.94 10l-1.72-1.72a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

export function SoundDropdown({
  enabled,
  soundName,
  volume,
  onSetEnabled,
  onSetSoundName,
  onCycleVolume,
}: SoundDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Notification sound settings"
        title="Notification sound settings"
        className={`rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-neutral-800 ${
          enabled ? "text-neutral-300" : "text-neutral-600"
        }`}
      >
        <SpeakerIcon enabled={enabled} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notification sound settings"
          className="absolute right-0 top-full z-20 mt-1 w-40 rounded-md border border-neutral-700 bg-neutral-800 p-1.5 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 px-1.5 py-1 text-xs text-neutral-300">
            <span>Sound</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Sound"
              onClick={() => onSetEnabled(!enabled)}
              className={`inline-flex h-5 w-9 items-center rounded-full border transition-colors ${
                enabled
                  ? "border-emerald-400/80 bg-emerald-500/30"
                  : "border-neutral-600 bg-neutral-900"
              }`}
            >
              <span
                aria-hidden="true"
                className={`ml-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  enabled ? "translate-x-4" : ""
                }`}
              />
            </button>
          </div>

          <div className="my-1 h-px bg-neutral-700" />

          <div className={`${enabled ? "" : "opacity-60"} transition-opacity`}>
            {SOUND_OPTIONS.map((option) => (
              <button
                key={option.name}
                type="button"
                onClick={() => onSetSoundName(option.name)}
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-sm transition-colors hover:bg-neutral-700/60 ${
                  soundName === option.name ? "text-neutral-100" : "text-neutral-300"
                }`}
                aria-pressed={soundName === option.name}
              >
                <span
                  aria-hidden="true"
                  className={`w-3 text-center ${soundName === option.name ? "text-emerald-400" : "text-transparent"}`}
                >
                  ●
                </span>
                <span>{option.label}</span>
              </button>
            ))}

            <div className="my-1 h-px bg-neutral-700" />

            <button
              type="button"
              onClick={onCycleVolume}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-sm text-neutral-300 transition-colors hover:bg-neutral-700/60"
            >
              <span aria-hidden="true" className="w-8 font-mono text-xs text-emerald-400">{VOLUME_DOTS[volume]}</span>
              <span className="capitalize">{volume}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
