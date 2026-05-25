"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buildApiUrl } from "@/lib/api";
import { PREFIX_WORD_COUNT, WORD_COUNT } from "@/lib/words";
import {
  isValidToken,
  isValidWord,
  matchingWords,
  normalizeTokenInput,
  splitToken,
} from "@/lib/token-validation";

/** Like normalizeTokenInput but preserves a trailing hyphen so the cursor
 *  stays after the separator while the user is still typing. */
function normalizeEditableValue(value: string): string {
  return value
    .toLowerCase()
    .trimStart()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/, "");
}

export function TokenInput() {
  const router = useRouter();
  const listboxId = useId();
  const [value, setValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [lookupStatus, setLookupStatus] = useState<"idle" | "loading" | "notFound">("idle");
  const lookupAbortRef = useRef<AbortController | null>(null);

  const normalizedToken = normalizeTokenInput(value);
  const words = splitToken(value);
  const segments = value.split("-");
  const activeWord = value.endsWith("-") ? "" : segments[segments.length - 1] ?? "";
  const enteredWordCount = Math.min(words.length, WORD_COUNT);
  const completedWordCount = value.endsWith("-")
    ? enteredWordCount
    : Math.max(enteredWordCount - 1, 0);
  const isJoinEnabled = isValidToken(normalizedToken);
  const lookupPrefix = useMemo(() => {
    if (words.length !== PREFIX_WORD_COUNT) {
      return null;
    }

    const prefixWords = words.slice(0, PREFIX_WORD_COUNT);
    return prefixWords.every((word) => isValidWord(word)) ? prefixWords.join("-") : null;
  }, [words]);

  const suggestions = useMemo(() => {
    if (!activeWord || completedWordCount >= WORD_COUNT) {
      return [];
    }

    const matches = matchingWords(activeWord);
    if (matches.length === 1 && matches[0] === activeWord) {
      return [];
    }
    return matches;
  }, [activeWord, completedWordCount]);

  useEffect(() => {
    if (!lookupPrefix) {
      lookupAbortRef.current?.abort();
      lookupAbortRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting derived state when dependency becomes null is intentional
      setLookupStatus("idle");
      return;
    }

    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;

    // Defer setting loading state to avoid synchronous state updates during effect
    const loadingTimeout = window.setTimeout(() => {
      if (lookupAbortRef.current === controller) {
        setLookupStatus("loading");
      }
    }, 0);

    let isCurrent = true;

    const lookup = async () => {
      try {
        const response = await fetch(
          buildApiUrl(`/api/sessions/lookup?prefix=${encodeURIComponent(lookupPrefix)}`),
          { signal: controller.signal },
        );

        if (!isCurrent || controller.signal.aborted) {
          return;
        }

        window.clearTimeout(loadingTimeout);

        if (response.status === 404) {
          setLookupStatus("notFound");
          return;
        }

        if (!response.ok) {
          setLookupStatus("idle");
          return;
        }

        const body = (await response.json()) as { token?: string };
        if (!isCurrent || controller.signal.aborted || !body.token) {
          return;
        }

        setLookupStatus("idle");
        router.push(`/${body.token}`);
      } catch (error) {
        window.clearTimeout(loadingTimeout);
        if ((error as Error).name === "AbortError" || !isCurrent || controller.signal.aborted) {
          return;
        }
        setLookupStatus("idle");
      }
    };

    void lookup();

    return () => {
      isCurrent = false;
      window.clearTimeout(loadingTimeout);
      controller.abort();
      if (lookupAbortRef.current === controller) {
        lookupAbortRef.current = null;
      }
    };
  }, [lookupPrefix, router]);

  const isListOpen = isFocused && suggestions.length > 0;
  const activeOptionId =
    isListOpen && suggestions[highlightedIndex]
      ? `${listboxId}-option-${highlightedIndex}`
      : undefined;

  const selectSuggestion = (word: string) => {
    const nextSegments = value.endsWith("-") ? [...segments, word] : [...segments.slice(0, -1), word];
    const filteredSegments = nextSegments.filter(Boolean).slice(0, WORD_COUNT);
    const nextValue =
      filteredSegments.length < WORD_COUNT ? `${filteredSegments.join("-")}-` : filteredSegments.join("-");

    setValue(nextValue);
    setHighlightedIndex(0);
  };

  const submitToken = () => {
    if (!isJoinEnabled) {
      return;
    }
    router.push(`/${normalizedToken}`);
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submitToken();
      }}
    >
      <div className="space-y-2 text-left">
        <label
          htmlFor="token-input"
          className="text-sm font-medium text-neutral-300"
        >
          Join existing session
        </label>
        <div className="relative">
          <input
            id="token-input"
            type="text"
            value={value}
            onChange={(event) => {
              setValue(normalizeEditableValue(event.target.value));
              setHighlightedIndex(0);
            }}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setIsFocused(false);
                return;
              }

              if (!isListOpen) {
                if (event.key === "Enter" && isJoinEnabled) {
                  event.preventDefault();
                  submitToken();
                }
                return;
              }

              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlightedIndex((current) => (current + 1) % suggestions.length);
                return;
              }

              if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlightedIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
                return;
              }

              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                selectSuggestion(suggestions[highlightedIndex] ?? suggestions[0]);
              }
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={isListOpen ? listboxId : undefined}
            aria-expanded={isListOpen}
            aria-activedescendant={activeOptionId}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="kudos-plant-anchor-maze-brood"
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 font-mono text-sm text-neutral-100 outline-none transition-colors placeholder:text-neutral-500 focus:border-blue-500"
          />
          {isListOpen && (
            <div
              id={listboxId}
              role="listbox"
              className="absolute z-10 mt-2 max-h-56 w-full overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-800 shadow-2xl"
            >
              {suggestions.map((suggestion, index) => {
                const isActive = index === highlightedIndex;
                return (
                  <div
                    key={suggestion}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={isActive}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectSuggestion(suggestion);
                    }}
                    className={`cursor-pointer px-4 py-2 font-mono text-sm ${
                      isActive
                        ? "bg-blue-600 text-white"
                        : "text-neutral-200 transition-colors hover:bg-neutral-700"
                    }`}
                  >
                    {suggestion}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {lookupStatus === "loading" ? (
          <p className="text-xs text-neutral-500" role="status">
            Searching for session...
          </p>
        ) : lookupStatus === "notFound" ? (
          <p className="text-xs text-amber-300" role="status">
            No session found
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-neutral-500">{enteredWordCount}/{WORD_COUNT} words</span>
        <button
          type="submit"
          disabled={!isJoinEnabled}
          aria-label="Join session"
          className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-800/60 disabled:text-neutral-500"
        >
          Join
        </button>
      </div>
    </form>
  );
}
