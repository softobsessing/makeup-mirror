#!/usr/bin/env node
/**
 * Fit the face-shape prototypes to labeled scans.
 *
 * The prototypes in src/lib/faceShape.ts started as anthropometric estimates.
 * This script replaces them with values measured from real faces:
 *
 *   prototype[shape][feature] = median of that feature across faces labeled `shape`
 *   sigma[feature]            = pooled within-class spread (robust, via MAD)
 *
 * Usage:
 *   1. In the app console, after each scan:  faceShapeCalibration.label("Heart")
 *   2. Then:                                 faceShapeCalibration.export()
 *      Save that JSON to samples.json.
 *   3. node scripts/fit-face-shape.mjs samples.json
 *
 * It prints a drop-in PROTOTYPES/SIGMA block plus a leave-one-out accuracy
 * estimate, so you can see whether the fit actually beats the current guesses.
 */

import { readFileSync } from "node:fs";

const FEATURES = [
  "elongation",
  "foreheadRel",
  "cheekRel",
  "jawRel",
  "widestZone",
  "jawAngle",
  "chinTaper",
  "thirdsRatio",
];

// Must mirror WEIGHT in src/lib/faceShape.ts.
const WEIGHT = {
  elongation: 1.2,
  foreheadRel: 1.1,
  cheekRel: 0.9,
  jawRel: 1.1,
  widestZone: 1.3,
  jawAngle: 1.0,
  chinTaper: 0.8,
  thirdsRatio: 0.5,
};
const TEMPERATURE = 3.2;
const MIN_PER_SHAPE = 3;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Median absolute deviation, scaled to be comparable to a standard deviation. */
const mad = (xs) => {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
};

function fit(rows) {
  const byShape = {};
  for (const r of rows) (byShape[r.label] ??= []).push(r.ratios);

  const protos = {};
  const spreads = {};
  for (const [shape, samples] of Object.entries(byShape)) {
    if (samples.length < MIN_PER_SHAPE) continue;
    protos[shape] = {};
    for (const f of FEATURES) {
      const vals = samples.map((s) => s[f]);
      protos[shape][f] = median(vals);
      (spreads[f] ??= []).push(mad(vals));
    }
  }

  // Pooled within-class spread → σ. Falls back if a class is degenerate.
  const sigma = {};
  for (const f of FEATURES) {
    const valid = (spreads[f] ?? []).filter((v) => v > 1e-6);
    sigma[f] = valid.length ? median(valid) : 0.05;
  }
  return { protos, sigma, byShape };
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

/** Leave-one-out: refit without each sample, then predict it. Honest estimate. */
function leaveOneOut(rows) {
  let correct = 0;
  let usable = 0;
  const confusion = {};
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, j) => j !== i);
    const { protos, sigma } = fit(train);
    if (!protos[rows[i].label]) continue; // class lost too many members
    usable++;
    const got = classify(rows[i].ratios, protos, sigma);
    if (got === rows[i].label) correct++;
    else {
      const k = `${rows[i].label} -> ${got}`;
      confusion[k] = (confusion[k] ?? 0) + 1;
    }
  }
  return { correct, usable, confusion };
}

// --------------------------------------------------------------------------

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/fit-face-shape.mjs samples.json");
  process.exit(1);
}

const rows = JSON.parse(readFileSync(path, "utf8")).filter((r) => r?.label && r?.ratios);
if (rows.length === 0) {
  console.error("no labeled samples found — did you run faceShapeCalibration.label(...)?");
  process.exit(1);
}

const { protos, sigma, byShape } = fit(rows);

console.log(`\nLabeled samples: ${rows.length}`);
for (const [shape, s] of Object.entries(byShape)) {
  const flag = s.length < MIN_PER_SHAPE ? `  (SKIPPED — needs ≥${MIN_PER_SHAPE})` : "";
  console.log(`  ${shape.padEnd(10)} ${String(s.length).padStart(3)}${flag}`);
}

const missing = Object.keys(byShape).filter((s) => !protos[s]);
if (missing.length) {
  console.log(`\nNot enough data to fit: ${missing.join(", ")}`);
  console.log("Those shapes keep their existing estimated prototypes.");
}

const loo = leaveOneOut(rows);
console.log(
  `\nLeave-one-out accuracy: ${
    loo.usable ? ((100 * loo.correct) / loo.usable).toFixed(1) : "n/a"
  }%  (${loo.correct}/${loo.usable})`,
);
const conf = Object.entries(loo.confusion).sort((a, b) => b[1] - a[1]);
if (conf.length) {
  console.log("Top confusions:");
  for (const [k, v] of conf.slice(0, 5)) console.log(`  ${k}  ×${v}`);
}

const n = (v) => Number(v.toFixed(v > 10 ? 1 : 3));
console.log("\n--- paste into src/lib/faceShape.ts ---\n");
console.log("const PROTOTYPES: Record<FaceShape, FaceRatios> = {");
for (const [shape, p] of Object.entries(protos)) {
  const body = FEATURES.map((f) => `${f}: ${n(p[f])}`).join(", ");
  console.log(`  ${shape}: { ${body} },`);
}
console.log("};\n");
console.log("const SIGMA: FaceRatios = {");
console.log(`  ${FEATURES.map((f) => `${f}: ${n(sigma[f])}`).join(",\n  ")},`);
console.log("};");
