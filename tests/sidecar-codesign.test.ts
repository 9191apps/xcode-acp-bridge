import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const signScript = path.join(repoRoot, "scripts", "codesign-sidecar.sh");
const bunSidecar = path.join(repoRoot, "dist", "sidecars", "acp-bridge");

function codesignVerify(file: string): { ok: boolean; stderr: string } {
  const proc = Bun.spawnSync(["codesign", "--verify", "--verbose", file], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function makeTinyMachO(dest: string): void {
  const src = dest + ".c";
  fs.writeFileSync(src, "int main(void) { return 0; }\n");
  const cc = Bun.spawnSync(["cc", "-o", dest, src]);
  if (cc.exitCode !== 0) {
    throw new Error(`cc failed: ${new TextDecoder().decode(cc.stderr)}`);
  }
}

describe("codesign-sidecar.sh", () => {
  test("adhoc-signs a Mach-O so codesign --verify passes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codesign-"));
    const target = path.join(dir, "acp-bridge");
    try {
      if (fs.existsSync(bunSidecar)) {
        fs.copyFileSync(bunSidecar, target);
        fs.chmodSync(target, 0o755);
      } else {
        makeTinyMachO(target);
      }

      const proc = Bun.spawnSync(
        ["bash", signScript, target, "apps.9191.ACPBridge.acp-bridge"],
        { stderr: "pipe", stdout: "pipe" },
      );
      expect(proc.exitCode).toBe(0);
      expect(codesignVerify(target).ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
