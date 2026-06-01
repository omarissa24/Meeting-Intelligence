#!/usr/bin/env node
// Parse `[latency] {...}` JSON log lines emitted by use-recording.ts and
// print p50/p95/p99/max for the e2eMs (WS-send → final-line-arrival) round
// trip. Reads stdin, ignores anything that isn't a `[latency] {...}` line.
//
// Usage:
//   pnpm tauri:dev 2>&1 | tee /tmp/latency.log
//   # ... record, stop ...
//   node apps/desktop/scripts/parse-latency-log.mjs < /tmp/latency.log

import { createInterface } from "node:readline";

const PREFIX = "[latency] ";

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  // Linear interpolation between closest ranks. Good enough for a
  // hundred-sample latency distribution.
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

const samples = [];
const rl = createInterface({ input: process.stdin });

for await (const raw of rl) {
  const idx = raw.indexOf(PREFIX);
  if (idx < 0) continue;
  const json = raw.slice(idx + PREFIX.length).trim();
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    continue;
  }
  if (typeof obj?.e2eMs === "number" && Number.isFinite(obj.e2eMs)) {
    samples.push(obj.e2eMs);
  }
}

if (samples.length === 0) {
  console.error("no [latency] samples found on stdin");
  process.exit(1);
}

samples.sort((a, b) => a - b);

const fmt = (x) => (x == null ? "—" : Math.round(x).toString());

console.log(`n=${samples.length}`);
console.log(
  `e2eMs   p50=${fmt(percentile(samples, 50))}  p95=${fmt(
    percentile(samples, 95),
  )}  p99=${fmt(percentile(samples, 99))}  max=${fmt(samples.at(-1))}`,
);
