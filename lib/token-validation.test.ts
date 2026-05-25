import { describe, expect, test } from "vitest";
import {
  isValidToken,
  isValidWord,
  matchingWords,
  normalizeTokenInput,
  splitToken,
} from "./token-validation";

describe("token validation helpers", () => {
  test("normalizes pasted token input", () => {
    expect(normalizeTokenInput("  KUDOS plant__ANCHOR   maze brood  ")).toBe(
      "kudos-plant-anchor-maze-brood"
    );
  });

  test("splits normalized tokens into words", () => {
    expect(splitToken("  kudos  plant-anchor ")).toEqual(["kudos", "plant", "anchor"]);
  });

  test("validates words and full tokens", () => {
    expect(isValidWord("kudos")).toBe(true);
    expect(isValidWord("nope")).toBe(false);
    expect(isValidToken("kudos-plant-anchor-maze-brood")).toBe(true);
    expect(isValidToken("kudos-plant-anchor-maze")).toBe(false);
    expect(isValidToken("kudos-plant-anchor-maze-nope")).toBe(false);
  });

  test("matches words without duplicate suggestions", () => {
    expect(matchingWords("bro")).toEqual(["brook", "broad", "broil", "brood", "brown"]);
    expect(matchingWords("br", 3)).toEqual(["branch", "brave", "bread"]);
  });

  test("matchingWords returns empty array for empty or whitespace-only prefix", () => {
    expect(matchingWords("")).toEqual([]);
    expect(matchingWords("   ")).toEqual([]);
    expect(matchingWords(" - ")).toEqual([]);
  });

  test("splitToken returns empty array for empty string", () => {
    expect(splitToken("")).toEqual([]);
  });
});
