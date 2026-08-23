import { describe, expect, test } from "bun:test";
import { config } from "../src/config";

describe("config", () => {
  test("defaults", () => {
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
  });
});
