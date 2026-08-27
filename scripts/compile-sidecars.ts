#!/usr/bin/env bun
import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";

const out = path.join(import.meta.dir, "..", "dist", "sidecars");
fs.mkdirSync(out, { recursive: true });

const targets = [
  { entry: "src/acp-bridge.ts", outfile: "acp-bridge" },
  { entry: "src/index.ts", outfile: "acp-serve" },
  { entry: "src/acp/cursor-acp-resume.ts", outfile: "cursor-acp-resume" },
  { entry: "src/acp/qoder-acp-resume.ts", outfile: "qoder-acp-resume" },
] as const;

for (const t of targets) {
  const outfile = path.join(out, t.outfile);
  await $`bun build --compile ${t.entry} --outfile ${outfile}`;
  await $`bash ${path.join(import.meta.dir, "codesign-sidecar.sh")} ${outfile} ${`apps.9191.ACPBridge.${t.outfile}`}`;
  console.log("compiled", outfile);
}
