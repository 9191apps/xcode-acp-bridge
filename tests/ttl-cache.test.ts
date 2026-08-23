import { describe, expect, test } from "bun:test";
import { createTtlCache } from "../src/dashboard/ttl-cache";

function fakeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createTtlCache", () => {
  test("loads once and reuses the value inside the TTL", () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = createTtlCache({ ttlMs: 30_000, now: clock.now, load: () => ++calls });

    expect(cache.get()).toBe(1);
    clock.advance(29_999);
    expect(cache.get()).toBe(1);
    expect(calls).toBe(1);
  });

  test("reloads once the TTL has elapsed", () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = createTtlCache({ ttlMs: 30_000, now: clock.now, load: () => ++calls });

    expect(cache.get()).toBe(1);
    clock.advance(30_000);
    expect(cache.get()).toBe(2);
    clock.advance(30_000);
    expect(cache.get()).toBe(3);
  });

  test("invalidate forces the next get to reload", () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = createTtlCache({ ttlMs: 30_000, now: clock.now, load: () => ++calls });

    expect(cache.get()).toBe(1);
    cache.invalidate();
    expect(cache.get()).toBe(2);
  });

  test("a throwing load is not cached", () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = createTtlCache<number>({
      ttlMs: 30_000,
      now: clock.now,
      load: () => {
        calls += 1;
        if (calls === 1) throw new Error("probe failed");
        return calls;
      },
    });

    expect(() => cache.get()).toThrow("probe failed");
    expect(cache.get()).toBe(2);
  });

  test("ttlMs of 0 disables caching", () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = createTtlCache({ ttlMs: 0, now: clock.now, load: () => ++calls });

    expect(cache.get()).toBe(1);
    expect(cache.get()).toBe(2);
  });
});
