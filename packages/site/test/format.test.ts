import { describe, expect, test } from "bun:test";
import { shortSha } from "../components/format.ts";

describe("shortSha", () => {
  test("keeps the first 12 characters", () => {
    expect(shortSha("a".repeat(64))).toBe("aaaaaaaaaaaa");
  });

  test("trims surrounding whitespace before shortening", () => {
    expect(shortSha("  0123456789abcdef  ")).toBe("0123456789ab");
  });

  test("returns a short value unchanged rather than padding it", () => {
    expect(shortSha("abc")).toBe("abc");
  });
});
