// One-off: vendor the dashboard fonts (JetBrains Mono + Chakra Petch) from
// Google Fonts into public/fonts with a local public/fonts.css. Rerun to
// refresh. Requires network access.
import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FONT_DEFS = [
  { family: "JetBrains Mono", css: "JetBrains+Mono:wght@400;500;600;700" },
  { family: "JetBrains Mono", css: "JetBrains+Mono:ital,wght@1,400" },
  { family: "Chakra Petch", css: "Chakra+Petch:wght@500;600;700" },
];

const outDir = path.join(import.meta.dir, "..", "public", "fonts");
fs.mkdirSync(outDir, { recursive: true });

const cssLines = [];
const seen = new Set();

for (const def of FONT_DEFS) {
  const url = `https://fonts.googleapis.com/css2?family=${def.css}&display=swap`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`css fetch failed ${res.status} for ${def.css}`);
  const css = await res.text();

  // Parse @font-face blocks; keep only latin subset, download the woff2.
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  for (const block of blocks) {
    if (!/unicode-range:\s*U\+0000-00FF/.test(block)) continue;
    const style = /font-style:\s*(\w+)/.exec(block)?.[1] ?? "normal";
    const weight = /font-weight:\s*(\d+)/.exec(block)?.[1] ?? "400";
    const srcUrl = /url\((https:[^)]+\.woff2)\)/.exec(block)?.[1];
    if (!srcUrl) continue;
    const slug = def.family.replace(/\s+/g, "-").toLowerCase();
    const key = `${slug}-${weight}-${style}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const file = path.join(outDir, `${key}.woff2`);
    const fontRes = await fetch(srcUrl, { headers: { "User-Agent": UA } });
    if (!fontRes.ok) throw new Error(`font fetch failed ${fontRes.status} for ${key}`);
    const buf = Buffer.from(await fontRes.arrayBuffer());
    fs.writeFileSync(file, buf);

    cssLines.push(`@font-face {
  font-family: '${def.family}';
  font-style: ${style};
  font-weight: ${weight};
  font-display: swap;
  src: url('/fonts/${path.basename(file)}') format('woff2');
}`);
    console.log(`vended ${path.basename(file)} (${buf.length} bytes)`);
  }
}

const out = cssLines.join("\n") + "\n";
fs.writeFileSync(path.join(import.meta.dir, "..", "public", "fonts.css"), out);
console.log(`wrote public/fonts.css (${out.length} bytes)`);
