import { WORD_COUNT, WORDS } from "@/lib/words";

const WORD_SET = new Set(WORDS);

export function normalizeTokenInput(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function splitToken(token: string): string[] {
  if (!token) {
    return [];
  }
  return normalizeTokenInput(token).split("-").filter(Boolean);
}

export function isValidWord(word: string): boolean {
  return WORD_SET.has(normalizeTokenInput(word));
}

export function isValidToken(token: string): boolean {
  const parts = splitToken(token);
  return parts.length === WORD_COUNT && parts.every((part) => WORD_SET.has(part));
}

export function matchingWords(prefix: string, limit = 8): string[] {
  const normalizedPrefix = normalizeTokenInput(prefix);
  if (!normalizedPrefix) {
    return [];
  }
  return WORDS.filter((word) => word.startsWith(normalizedPrefix)).slice(0, limit);
}
