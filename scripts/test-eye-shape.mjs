#!/usr/bin/env node
/**
 * Sanity check for the eye classifier.
 *
 * Runs the real compiled module over the 16 full-face fixture photos and prints
 * every measurement plus the resulting label. There are no eye-type ground
 * truths for these faces, so this checks DISTRIBUTION, not accuracy: each axis
 * should produce a spread of answers rather than collapsing to one.
 *
 * Prerequisites (produced by the detection step):
 *   /tmp/faceraw/meta.json  — landmarks + raw grayscale buffers
 *
 * Usage:  node scripts/test-eye-shape.mjs
 */
import { readFileSync } from "node:fs";
import { measureEyes, analyseCrease, classifyEyes } from "/tmp/eye.mjs";
const meta = JSON.parse(readFileSync("/tmp/faceraw/meta.json", "utf8"));
console.log("file                    tilt°  spacing aperture  crease(str/ht)  ->  summary");
console.log("-".repeat(96));
const lidCount = {};
for (const m of meta) {
  const buf = readFileSync(m.raw);
  const sample = (x, y) => (x < 0 || y < 0 || x >= m.w || y >= m.h ? 0 : buf[y * m.w + x]);
  const lm = m.pts.map(([x, y]) => ({ x, y }));
  const met = measureEyes(lm, m.w, m.h);
  if (!met) continue;
  const rs = ["right", "left"].map((s) => analyseCrease(lm, m.w, m.h, sample, s)).filter(Boolean);
  const cr = { strength: rs.reduce((a,b)=>a+b.strength,0)/rs.length,
               height: rs.reduce((a,b)=>a+b.height,0)/rs.length };
  const res = classifyEyes(met, cr);
  if (res.lid) lidCount[res.lid.value] = (lidCount[res.lid.value] ?? 0) + 1;
  console.log(
    `${m.label.slice(0,22).padEnd(23)} ${met.tiltDeg.toFixed(1).padStart(5)}  ` +
    `${met.spacingRatio.toFixed(2)}    ${met.apertureRatio.toFixed(2)}     ` +
    `${cr.strength.toFixed(2)}/${cr.height.toFixed(2)}     ${res.summary}`);
}
console.log("\nlid distribution:", Object.keys(lidCount).length ? JSON.stringify(lidCount)
  : "(disabled — see LID_DETECTION_ENABLED in eyeShape.ts)");
