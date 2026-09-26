import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAcpBridgeConfig, repoRoot, writeRouteYolo } from "../src/acp/config";

function writeCfg(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cfg-"));
  const cfgPath = path.join(dir, "cfg.json");
  fs.writeFileSync(cfgPath, JSON.stringify(body));
  return cfgPath;
}

describe("loadAcpBridgeConfig", () => {
  test("loads routes and resolves paths against repo root", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
        defaultRoute: "opencode",
        eventsPath: "./data/acp-events.jsonl",
        routeStatePath: "./data/acp-route.json",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.defaultRoute).toBe("opencode");
    expect(cfg.routes.opencode.command).toBe("/bin/echo");
    expect(cfg.defaultBackend).toEqual({ command: "/bin/echo", args: ["acp"] });
    expect(cfg.eventsPath).toBe(path.join(repoRoot(), "data/acp-events.jsonl"));
    expect(cfg.routeStatePath).toBe(path.join(repoRoot(), "data/acp-route.json"));
    expect(cfg.maxRawBytes).toBe(99);
  });

  test("defaultBackend-only config becomes routes.default", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        defaultBackend: { command: "/bin/echo", args: ["acp"] },
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.defaultRoute).toBe("default");
    expect(cfg.routes.default.command).toBe("/bin/echo");
    expect(cfg.defaultBackend.command).toBe("/bin/echo");
    expect(cfg.routeStatePath).toBe(path.join(repoRoot(), "data/acp-route.json"));
  });

  test("expands ~ and env vars in command, args, and modelsCommand", () => {
    const home = os.homedir();
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          opencode: {
            command: "~/bin/opencode",
            args: ["acp", "$HOME/tmp", "${OPENCODE_MODEL:-dummy}"],
            modelsCommand: { command: "${HOME}/bin/opencode", args: ["models"] },
          },
        },
        defaultRoute: "opencode",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.opencode.command).toBe(`${home}/bin/opencode`);
    expect(cfg.routes.opencode.args).toEqual(["acp", `${home}/tmp`, ""]);
    expect(cfg.routes.opencode.modelsCommand).toEqual({
      command: `${home}/bin/opencode`,
      args: ["models"],
    });
  });

  test("does not expand ~ inside a path and expands defaultBackend form", () => {
    const home = os.homedir();
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        defaultBackend: { command: "~/.opencode/bin/opencode", args: ["acp"] },
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.default.command).toBe(`${home}/.opencode/bin/opencode`);
    expect(cfg.defaultBackend.command).toBe(`${home}/.opencode/bin/opencode`);
  });

  test("throws when routes empty and no defaultBackend", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {},
          defaultRoute: "x",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 1,
        }),
      ),
    ).toThrow(/routes/i);
  });

  test("throws when defaultRoute is not a route key", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
          defaultRoute: "missing",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 1,
        }),
      ),
    ).toThrow(/defaultRoute/);
  });

  test("throws naming the route key when a routes entry is not a backend", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            opencode: { command: "/bin/echo", args: ["acp"] },
            broken: { command: "/bin/false" },
          },
          defaultRoute: "opencode",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 1,
        }),
      ),
    ).toThrow(/routes\.broken/);
  });

  test("loads optional modelsCommand per route", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          opencode: {
            command: "/bin/echo",
            args: ["acp"],
            modelsCommand: { command: "/bin/echo", args: ["models"] },
          },
        },
        defaultRoute: "opencode",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.opencode.modelsCommand).toEqual({ command: "/bin/echo", args: ["models"] });
  });

  test("loads optional modelApply and resumeArgs", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          cursor: {
            command: "/bin/echo",
            args: ["acp"],
            modelApply: "spawn-arg",
            resumeArgs: ["--resume", "{sessionId}"],
          },
        },
        defaultRoute: "cursor",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.cursor.modelApply).toBe("spawn-arg");
    expect(cfg.routes.cursor.resumeArgs).toEqual(["--resume", "{sessionId}"]);
  });

  test("throws naming the route key when modelApply is invalid", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            cursor: { command: "/bin/echo", args: ["acp"], modelApply: "spawn" },
          },
          defaultRoute: "cursor",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 99,
        }),
      ),
    ).toThrow(/routes\.cursor/);
  });

  test("throws naming the route key when resumeArgs is invalid", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            cursor: { command: "/bin/echo", args: ["acp"], resumeArgs: "--resume" },
          },
          defaultRoute: "cursor",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 99,
        }),
      ),
    ).toThrow(/routes\.cursor/);
  });

  test("throws naming the route key when modelsCommand is invalid", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            opencode: { command: "/bin/echo", args: ["acp"], modelsCommand: { command: "/bin/echo" } },
          },
          defaultRoute: "opencode",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 99,
        }),
      ),
    ).toThrow(/routes\.opencode/);
  });

  test("throws when maxRawBytes is missing", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
          defaultRoute: "opencode",
          eventsPath: "./data/acp-events.jsonl",
        }),
      ),
    ).toThrow(/maxRawBytes/);
  });

  test("throws when maxRawBytes is not a positive number", () => {
    const body = {
      routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
      defaultRoute: "opencode",
      eventsPath: "./data/acp-events.jsonl",
    };
    expect(() => loadAcpBridgeConfig(writeCfg({ ...body, maxRawBytes: 0 }))).toThrow(/maxRawBytes/);
    expect(() => loadAcpBridgeConfig(writeCfg({ ...body, maxRawBytes: -1 }))).toThrow(/maxRawBytes/);
    expect(() => loadAcpBridgeConfig(writeCfg({ ...body, maxRawBytes: "2097152" }))).toThrow(/maxRawBytes/);
  });

  test("loads resumeMode qoder-acp-load", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          qodercli: {
            command: "/bin/echo",
            args: ["--acp"],
            modelApply: "spawn-arg",
            resumeMode: "qoder-acp-load",
          },
        },
        defaultRoute: "qodercli",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.qodercli.resumeMode).toBe("qoder-acp-load");
    expect(cfg.routes.qodercli.modelApply).toBe("spawn-arg");
  });

  test("throws naming the route key when resumeMode is invalid", () => {
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          routes: {
            qodercli: { command: "/bin/echo", args: ["--acp"], resumeMode: "cli-r" },
          },
          defaultRoute: "qodercli",
          eventsPath: "./data/acp-events.jsonl",
          maxRawBytes: 99,
        }),
      ),
    ).toThrow(/routes\.qodercli/);
  });

  test("route-level yolo is kept and defaults to off", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        routes: {
          opencode: { command: "/bin/echo", args: ["acp"] },
          cursor: { command: "/bin/echo", args: ["acp"], yolo: true },
        },
        defaultRoute: "opencode",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.cursor.yolo).toBe(true);
    // Off means the field is absent, so every existing consumer sees the old shape.
    expect("yolo" in cfg.routes.opencode).toBe(false);
    expect("yolo" in cfg.defaultBackend).toBe(false);
  });

  test("top-level yolo enables every route and a route can opt out", () => {
    const cfg = loadAcpBridgeConfig(
      writeCfg({
        yolo: true,
        routes: {
          opencode: { command: "/bin/echo", args: ["acp"] },
          cursor: { command: "/bin/echo", args: ["acp"], yolo: false },
          qodercli: { command: "/bin/echo", args: ["--acp"] },
        },
        defaultRoute: "opencode",
        eventsPath: "./data/acp-events.jsonl",
        maxRawBytes: 99,
      }),
    );
    expect(cfg.routes.opencode.yolo).toBe(true);
    expect(cfg.defaultBackend.yolo).toBe(true);
    expect(cfg.routes.qodercli.yolo).toBe(true);
    expect("yolo" in cfg.routes.cursor).toBe(false);
  });

  test("throws when yolo is not a boolean", () => {
    const base = {
      routes: { opencode: { command: "/bin/echo", args: ["acp"] } },
      defaultRoute: "opencode",
      eventsPath: "./data/acp-events.jsonl",
      maxRawBytes: 99,
    };
    expect(() =>
      loadAcpBridgeConfig(writeCfg({ ...base, yolo: "yes" })),
    ).toThrow(/yolo must be a boolean/);
    expect(() =>
      loadAcpBridgeConfig(
        writeCfg({
          ...base,
          routes: { opencode: { command: "/bin/echo", args: ["acp"], yolo: "on" } },
        }),
      ),
    ).toThrow(/routes\.opencode/);
  });
});

describe("writeRouteYolo", () => {
  function writeCfgFile(body: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-yolo-"));
    const cfgPath = path.join(dir, "acp-bridge.config.json");
    fs.writeFileSync(cfgPath, `${JSON.stringify(body, null, 2)}\n`);
    return cfgPath;
  }

  const base = {
    routes: {
      opencode: { command: "/bin/echo", args: ["acp"] },
      cursor: { command: "/bin/echo", args: ["acp"], modelApply: "spawn-arg" },
    },
    defaultRoute: "opencode",
    eventsPath: "./data/acp-events.jsonl",
    maxRawBytes: 99,
  };

  test("sets one route's yolo and leaves the rest of the file alone", () => {
    const cfgPath = writeCfgFile(base);
    writeRouteYolo(cfgPath, "opencode", true);

    const cfg = loadAcpBridgeConfig(cfgPath);
    expect(cfg.routes.opencode.yolo).toBe(true);
    expect("yolo" in cfg.routes.cursor).toBe(false);
    expect(cfg.routes.cursor.modelApply).toBe("spawn-arg");
    expect(cfg.routes.opencode.command).toBe("/bin/echo");
    expect(cfg.defaultRoute).toBe("opencode");

    const text = fs.readFileSync(cfgPath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).routes.opencode.yolo).toBe(true);
  });

  test("writes an explicit route-level false so it overrides a top-level yolo", () => {
    const cfgPath = writeCfgFile({ ...base, yolo: true });
    writeRouteYolo(cfgPath, "cursor", false);

    const cfg = loadAcpBridgeConfig(cfgPath);
    expect("yolo" in cfg.routes.cursor).toBe(false);
    expect(cfg.routes.opencode.yolo).toBe(true);
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).routes.cursor.yolo).toBe(false);
  });

  test("is idempotent and leaves no temp file behind", () => {
    const cfgPath = writeCfgFile(base);
    writeRouteYolo(cfgPath, "opencode", true);
    const first = fs.readFileSync(cfgPath, "utf8");
    writeRouteYolo(cfgPath, "opencode", true);
    expect(fs.readFileSync(cfgPath, "utf8")).toBe(first);
    expect(fs.readdirSync(path.dirname(cfgPath))).toEqual(["acp-bridge.config.json"]);
  });

  test("drops the route key when the value matches the top-level default", () => {
    const cfgPath = writeCfgFile({ ...base, yolo: true });
    const before = fs.readFileSync(cfgPath, "utf8");
    // routes.opencode is already on via the top-level default, so the switch round-trips to nothing.
    writeRouteYolo(cfgPath, "opencode", true);
    expect(fs.readFileSync(cfgPath, "utf8")).toBe(before);
    writeRouteYolo(cfgPath, "opencode", false);
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).routes.opencode.yolo).toBe(false);
    writeRouteYolo(cfgPath, "opencode", true);
    expect(fs.readFileSync(cfgPath, "utf8")).toBe(before);
    expect(loadAcpBridgeConfig(cfgPath).routes.opencode.yolo).toBe(true);
  });

  test("throws for an unknown route without touching the file", () => {
    const cfgPath = writeCfgFile(base);
    const before = fs.readFileSync(cfgPath, "utf8");
    expect(() => writeRouteYolo(cfgPath, "nope", true)).toThrow(/unknown route nope/);
    expect(fs.readFileSync(cfgPath, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(cfgPath))).toEqual(["acp-bridge.config.json"]);
  });

  test("throws when the config has no routes to switch", () => {
    const cfgPath = writeCfgFile({
      defaultBackend: { command: "/bin/echo", args: ["acp"] },
      eventsPath: "./data/acp-events.jsonl",
      maxRawBytes: 99,
    });
    expect(() => writeRouteYolo(cfgPath, "opencode", true)).toThrow(/routes is empty/);
  });
});
