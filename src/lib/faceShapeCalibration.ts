import type { FaceShape } from "../types/makeup";
import type { FaceRatios, FaceShapeScore } from "./faceShape";

/**
 * Calibration capture for the face-shape classifier.
 *
 * The prototype vectors in `faceShape.ts` are informed anthropometric estimates,
 * not values fitted to labeled faces — that is the last real gap in accuracy.
 * This module records the measured feature vector of every scan so those
 * prototypes can eventually be fitted to reality.
 *
 * It is deliberately console-driven (no UI): capture is passive, and the helpers
 * are exposed on `window.faceShapeCalibration` for use during a labeling session.
 *
 *   faceShapeCalibration.label("Heart")   // tag the most recent scan
 *   faceShapeCalibration.list()           // review what's collected
 *   faceShapeCalibration.export()         // copy/save JSON for the fitter
 *   faceShapeCalibration.clear()
 *
 * Then: node scripts/fit-face-shape.mjs samples.json
 */

const STORAGE_KEY = "faceShapeCalibrationSamples";
const MAX_SAMPLES = 500;

export interface CalibrationSample {
  /** Ground-truth shape, filled in by `label()` after the scan. */
  label: FaceShape | null;
  /** What the classifier predicted (for measuring agreement). */
  predicted: FaceShape;
  confidence: number;
  /** The averaged feature vector — the thing we actually fit against. */
  ratios: FaceRatios;
  /** How many pose-accepted frames were averaged. */
  samples: number;
  capturedAt: string;
}

function read(): CalibrationSample[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CalibrationSample[]) : [];
  } catch {
    return []; // storage disabled / corrupt — capture is best-effort
  }
}

function write(rows: CalibrationSample[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(-MAX_SAMPLES)));
  } catch {
    /* best-effort */
  }
}

/** Record one scan. Called automatically after every calibration. */
export function captureScan(
  ratios: FaceRatios,
  ranked: FaceShapeScore[],
  samples: number,
): void {
  const rows = read();
  rows.push({
    label: null,
    predicted: ranked[0].shape,
    confidence: ranked[0].confidence,
    ratios,
    samples,
    capturedAt: new Date().toISOString(),
  });
  write(rows);
}

/** Tag the most recent scan with its true shape. */
function label(shape: FaceShape): string {
  const rows = read();
  if (rows.length === 0) return "no scans captured yet";
  rows[rows.length - 1].label = shape;
  write(rows);
  const labeled = rows.filter((r) => r.label).length;
  return `labeled last scan as ${shape} (${labeled}/${rows.length} labeled)`;
}

/** Summary of what's been collected, by label. */
function list(): { total: number; labeled: number; byLabel: Record<string, number>; agreement: string } {
  const rows = read();
  const labeled = rows.filter((r) => r.label);
  const byLabel: Record<string, number> = {};
  let agree = 0;
  for (const r of labeled) {
    byLabel[r.label!] = (byLabel[r.label!] ?? 0) + 1;
    if (r.label === r.predicted) agree++;
  }
  return {
    total: rows.length,
    labeled: labeled.length,
    byLabel,
    agreement: labeled.length
      ? `${((100 * agree) / labeled.length).toFixed(0)}% (${agree}/${labeled.length})`
      : "n/a",
  };
}

/** JSON of the labeled samples, ready for the fitting script. */
function exportJson(): string {
  const json = JSON.stringify(read().filter((r) => r.label), null, 2);
  console.info(
    "%cCopy the JSON below into samples.json, then run:\n" +
      "  node scripts/fit-face-shape.mjs samples.json",
    "font-weight:bold",
  );
  return json;
}

function clear(): string {
  write([]);
  return "cleared";
}

/** Attach the console helpers. Safe to call more than once. */
export function installCalibrationConsole(): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).faceShapeCalibration = {
    label,
    list,
    export: exportJson,
    clear,
  };
}
