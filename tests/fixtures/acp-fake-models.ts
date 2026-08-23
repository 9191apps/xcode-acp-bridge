import fs from "node:fs";

const counterPath = process.argv[2]!;
let n = 0;
try {
  n = Number(fs.readFileSync(counterPath, "utf8"));
} catch {
  // first run
}
n += 1;
fs.writeFileSync(counterPath, String(n));
console.log(`model-${n}`);
