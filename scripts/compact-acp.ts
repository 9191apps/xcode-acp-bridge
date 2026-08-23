// One-time compaction of existing ACP event data: rewrites every conversation
// file under the events dir with chunk aggregation applied, so legacy
// unaggregated data shrinks like live appends do.
//
//   bun run scripts/compact-acp.ts
//
// Skips files modified in the last minute (a live bridge may still be writing
// them) and prints per-file and total stats. Idempotent and safe to re-run.
import { AcpEventStore } from "../src/acp/event-store";
import { loadAcpBridgeConfig } from "../src/acp/config";

const cfg = loadAcpBridgeConfig();
const store = new AcpEventStore(cfg.eventsPath);
await store.load();

const t0 = performance.now();
const stats = await store.compactAll();
const dt = (performance.now() - t0).toFixed(0);

const fmt = (n: number) => n.toLocaleString("en-US");
console.log(`\nCompacted ${stats.files} conversation file(s) in ${dt}ms:`);
console.log(`  lines:  ${fmt(stats.linesBefore)} -> ${fmt(stats.linesAfter)}  (-${(100 * (1 - stats.linesAfter / Math.max(1, stats.linesBefore))).toFixed(1)}%)`);
console.log(
  `  bytes:  ${(stats.bytesBefore / 1048576).toFixed(1)} MB -> ${(stats.bytesAfter / 1048576).toFixed(2)} MB  (-${(100 * (1 - stats.bytesAfter / Math.max(1, stats.bytesBefore))).toFixed(1)}%)`,
);
if (stats.skipped.length > 0) {
  console.log(`\nSkipped ${stats.skipped.length} file(s) modified in the last minute (possibly still live):`);
  for (const name of stats.skipped) console.log(`  ${name}`);
  console.log("Re-run the script later to compact them.");
}

// Post-compaction sanity: summaries and total chunk counts per conversation.
const after = new AcpEventStore(cfg.eventsPath);
await after.load();
let chunkTotal = 0;
for (const s of after.summaries()) {
  const detail = after.detail(s.bridgePid);
  const rows = (detail?.timeline ?? []).filter((t) => t.type === "chunks");
  const count = rows.reduce((n, t) => n + t.count, 0);
  chunkTotal += count;
}
console.log(`\nSanity: ${after.summaries().length} conversation(s), ${fmt(chunkTotal)} chunk rows preserved across timelines.`);
