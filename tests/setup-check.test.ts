import { describe, expect, test } from "bun:test";
import { detectBackendBinary, detectQodercli } from "../src/setup-check";

describe("detectBackendBinary", () => {
  test("qodercli route prefers qoder detection over opencode", () => {
    // basename qodercli → detectQodercli path; may be null on CI without install — assert function runs and does not throw
    expect(() => detectBackendBinary("qodercli", "/tmp/qodercli")).not.toThrow();
    const detected = detectBackendBinary("qodercli", "/tmp/qodercli");
    expect(detected).toBe(detectQodercli());
  });
});

describe("detectQodercli", () => {
  test("returns null or an executable path", () => {
    const result = detectQodercli();
    expect(result === null || typeof result === "string").toBe(true);
  });
});
