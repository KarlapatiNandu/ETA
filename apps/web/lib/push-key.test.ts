import { describe, expect, it } from "vitest";
import { sameKey, urlBase64ToUint8Array } from "./push-key";

describe("sameKey (a rotated VAPID key heals on the next visit)", () => {
  const key =
    "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
  it("matches the key a subscription was made with, and nothing else", () => {
    expect(sameKey(urlBase64ToUint8Array(key).buffer, key)).toBe(true);
    const other = urlBase64ToUint8Array(key);
    other[10] = other[10]! ^ 1;
    expect(sameKey(other.buffer, key)).toBe(false);
    expect(sameKey(new Uint8Array(3).buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(true);
  });
});
