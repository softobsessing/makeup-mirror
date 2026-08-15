#!/usr/bin/env node
/**
 * Regression test for the face-shape classifier.
 *
 * Runs the REAL classifier over 16 labeled faces whose landmarks are cached in
 * test-fixtures/ (MediaPipe detection took ~16 minutes; the cache makes this
 * instant). Run it after ANY change to faceShape.ts.
 *
 * WHAT THIS GUARDS
 * ----------------
 * The recurring failure of this classifier has NOT been mild inaccuracy — it is
 * DEGENERACY: whichever prototype sits nearest the average measurement wins for
 * every face, so the app returns one shape for everyone. That has happened
 * three times ("everyone is Heart", then Square, then a flood of Triangle), and
 * each time an accuracy score alone failed to reveal it.
 *
 * So the hard check here is DISTRIBUTION HEALTH: the classifier must produce a
 * variety of answers and no single shape may dominate. Accuracy against the
 * fixture labels is printed for information only — those 16 labels are scraped
 * and unverified, and live scanning has repeatedly disagreed with them.
 *
 * Usage:  node scripts/test-face-shape.mjs      (from the project root)
 */

import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compile the real module so this test can never drift from what ships.
const out = join(mkdtempSync(join(tmpdir(), "faceshape-")), "faceShape.mjs");
execFileSync(
  "npx",
  ["esbuild", "src/lib/faceShape.ts", "--bundle", "--format=esm", `--outfile=${out}`],
  { stdio: "ignore" },
);
const { classifyFaceShape } = await import(out);

const rows = JSON.parse(readFileSync("test-fixtures/face-shape-landmarks.json", "utf8"));
const COMPACT = ["Round", "Square"];

let inShortlist = 0;
let top1 = 0;
let lengthOk = 0;

console.log("file                       true        length      shortlist");
console.log("-".repeat(78));
for (const r of rows) {
  const res = classifyFaceShape(r.pts.map(([x, y]) => ({ x, y })), r.w, r.h);
  const trueLength = COMPACT.includes(r.label) ? "compact" : "elongated";

  const lenOk = res.lengthClass === trueLength;
  if (lenOk) lengthOk++;
  const listed = res.candidates.includes(r.label);
  if (listed) inShortlist++;
  if (res.shape === r.label) top1++;

  console.log(
    `${r.file.padEnd(26)} ${r.label.padEnd(11)} ` +
      `${(lenOk ? "✔ " : "✘ ") + res.lengthClass.padEnd(10)} ` +
      `${(listed ? "✔ " : "✘ ") + res.candidates.join(", ")}`,
  );
}

const n = rows.length;
const pct = (k) => `${((100 * k) / n).toFixed(0)}%  (${k}/${n})`;
console.log("-".repeat(78));
console.log(`length class correct   : ${pct(lengthOk)}    [chance 50%]`);
console.log(`true shape shortlisted : ${pct(inShortlist)}    [chance ~43%]`);
console.log(`top-1 exact            : ${pct(top1)}    [chance 14%]`);

// ---- degeneracy check (the real guard) ----
const dist = {};
for (const r of rows) {
  const res = classifyFaceShape(r.pts.map(([x, y]) => ({ x, y })), r.w, r.h);
  dist[res.shape] = (dist[res.shape] ?? 0) + 1;
}
console.log("\nguess distribution:");
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(11)} ${"#".repeat(v)} ${v}`);
}

const distinct = Object.keys(dist).length;
const topShare = Math.max(...Object.values(dist)) / n;
console.log(`\ndistinct shapes ${distinct}/7   most common ${(100 * topShare).toFixed(0)}% of guesses`);

if (distinct < 4 || topShare > 0.5) {
  console.error(
    "\nREGRESSION: classifier has collapsed toward one shape.\n" +
      "Usually means the prototypes drifted off the measurement scale — see\n" +
      "alignToMeasuredScale() in faceShape.ts.",
  );
  process.exit(1);
}
console.log("\nOK — no degeneracy.");
