import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode } from "./base58.ts";

describe("base58", () => {
  it("round-trips the all-zero and max keys", () => {
    for (const key of [new Uint8Array(32), new Uint8Array(32).fill(255), Uint8Array.of(0, 0, 1)]) {
      expect(base58Decode(base58Encode(key))).toEqual(key);
    }
    expect(base58Encode(new Uint8Array(32))).toBe("1".repeat(32));
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base58Decode("0OIl")).toThrow();
  });
});
