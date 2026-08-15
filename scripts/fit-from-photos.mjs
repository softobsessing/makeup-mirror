#!/usr/bin/env node
/**
 * Fit the face-shape prototypes from labeled PHOTOS.
 *
 * Why this exists: the original prototypes were anatomical estimates written by
 * hand, and testing revealed they sit in a different numeric range than
 * `measureFrame` actually outputs — so several features had almost no
 * discriminating power in practice. This script derives prototypes from the
 * measurement code's own output, which is the only way they can be correct.
 *
 * It imports the REAL `measureFrame` from src/lib/faceShape.ts (compiled on the
 * fly) so there is no risk of a re-implementation drifting from the app.
 *
 * Input: JSON array of { label, file, w, h, pts:[[x,y],...] } — landmarks
 * detected offline by MediaPipe (see the Python detection step).
 *
 * Usage:
 *   npx esbuild src/lib/faceShape.ts --bundle --format=esm --outfile=/tmp/fs.mjs
 *   node scripts/fit-from-photos.mjs /tmp/faceshape_lm.json /tmp/fs.mjs
 *
 * Prints a drop-in PROTOTYPES/SIGMA block plus per-feature diagnostics and a
 * leave-one-out accuracy estimate.
 */

import { readFileSync } from "node:fs";

const FEATURES = [
  "elongation",
  "uniformity",
  "jawToLen",
  "cheekToIod",
  "chinTaper",
  "jawAngle",
];

// Must mirror WEIGHT in src/lib/faceShape.ts.
const WEIGHT = {
  elongation: 2.0, uniformity: 0.9, jawToLen: 0.9,
  cheekToIod: 0.7, chinTaper: 0.8, jawAngle: 0.6,
};
const TEMPERATURE = 3.2;

/** With 2-3 photos per class the measured spread is mostly noise, so sigma is
 *  shrunk toward a prior derived from how far the class centres sit apart. */
const SHRINK = 4.0;
const MIN_PER_CLASS = 2;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mad = (xs) => {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
};
const stdev = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

function fit(rows) {
  const by = {};
  for (const r of rows) (by[r.label] ??= []).push(r.ratios);

  const protos = {};
  const within = {};
  for (const [shape, samples] of Object.entries(by)) {
    if (samples.length < MIN_PER_CLASS) continue;
    protos[shape] = {};
    for (const f of FEATURES) {
      const vals = samples.map((s) => s[f]);
      protos[shape][f] = median(vals);
      const d = mad(vals);
      if (d > 1e-9) (within[f] ??= []).push(d);
    }
  }

  // Prior: a fraction of how far the class centres actually spread. This keeps
  // sigma on the same scale as the data instead of an arbitrary constant.
  const n = Math.min(...Object.values(by).map((s) => s.length));
  const w = n / (n + SHRINK);
  const sigma = {};
  for (const f of FEATURES) {
    const centres = Object.values(protos).map((p) => p[f]);
    const prior = Math.max(stdev(centres) * 0.55, 1e-6);
    const fitted = within[f]?.length ? median(within[f]) : prior;
    sigma[f] = w * fitted + (1 - w) * prior;
  }
  return { protos, sigma, by };
}

function classify(ratios, protos, sigma) {
  let best = null;
  for (const [shape, p] of Object.entries(protos)) {
    let d2 = 0;
    for (const f of FEATURES) {
      const z = (ratios[f] - p[f]) / sigma[f];
      d2 += WEIGHT[f] * z * z;
    }
    const score = Math.exp(-d2 / (2 * TEMPERATURE));
    if (!best || score > best.score) best = { shape, score };
  }
  return best?.shape ?? null;
}

// --------------------------------------------------------------------------

const [lmPath, modPath] = process.argv.slice(2);
if (!lmPath || !modPath) {
  console.error("usage: node scripts/fit-from-photos.mjs <landmarks.json> <compiled faceShape.mjs>");
  process.exit(1);
}
const { measureFrame } = await import(modPath);

const raw = JSON.parse(readFileSync(lmPath, "utf8"));
const rows = raw.map((r) => {
  const m = measureFrame(r.pts.map(([x, y]) => ({ x, y })), r.w, r.h);
  const ratios = {};
  for (const f of FEATURES) ratios[f] = m[f];
  return { label: r.label, file: r.file, ratios };
});

const { protos, sigma, by } = fit(rows);

console.log(`\nPhotos measured: ${rows.length}`);
for (const [shape, s] of Object.entries(by).sort()) {
  const flag = s.length < MIN_PER_CLASS ? `  (SKIPPED — needs >= ${MIN_PER_CLASS})` : "";
  console.log(`  ${shape.padEnd(11)}${String(s.length).padStart(3)}${flag}`);
}

// Which features actually separate these classes? between-class spread over
// within-class spread. Below ~1 the feature is carrying no signal.
console.log("\nFeature diagnostics (between-class spread / within-class spread):");
for (const f of FEATURES) {
  const centres = Object.values(protos).map((p) => p[f]);
  const between = stdev(centres);
  const withinVals = Object.values(by)
    .filter((s) => s.length >= 2)
    .map((s) => stdev(s.map((x) => x[f])));
  const w = withinVals.length ? median(withinVals) : 0;
  const ratio = w > 1e-9 ? between / w : Infinity;
  const verdict = ratio >= 1.5 ? "good" : ratio >= 0.9 ? "weak" : "NO SIGNAL";
  console.log(
    `  ${f.padEnd(13)} between ${between.toFixed(3).padStart(7)}  within ${w.toFixed(3).padStart(7)}` +
      `  ratio ${(ratio === Infinity ? "inf" : ratio.toFixed(2)).padStart(5)}  ${verdict}`,
  );
}

// Leave-one-out: refit without each photo, then predict it.
let correct = 0, usable = 0;
const confusion = {};
for (let i = 0; i < rows.length; i++) {
  const train = rows.filter((_, j) => j !== i);
  const { protos: p2, sigma: s2 } = fit(train);
  if (!p2[rows[i].label]) continue;
  usable++;
  const got = classify(rows[i].ratios, p2, s2);
  if (got === rows[i].label) correct++;
  else confusion[`${rows[i].label} -> ${got}`] = (confusion[`${rows[i].label} -> ${got}`] ?? 0) + 1;
}
console.log(
  `\nLeave-one-out accuracy: ${usable ? ((100 * correct) / usable).toFixed(1) : "n/a"}%  (${correct}/${usable})`,
);
for (const [k, v] of Object.entries(confusion).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${k}  x${v}`);
}

const n = (v) => Number(v.toFixed(Math.abs(v) > 10 ? 1 : 3));
console.log("\n--- paste into src/lib/faceShape.ts ---\n");
console.log("const PROTOTYPES: Record<FaceShape, FaceRatios> = {");
for (const [shape, p] of Object.entries(protos)) {
  console.log(`  ${shape}: { ${FEATURES.map((f) => `${f}: ${n(p[f])}`).join(", ")} },`);
}
console.log("};\n");
console.log("const SIGMA: FaceRatios = {");
console.log(`  ${FEATURES.map((f) => `${f}: ${n(sigma[f])}`).join(",\n  ")},`);
console.log("};");
