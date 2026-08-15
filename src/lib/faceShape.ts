import type { FaceShape } from "../types/makeup";

/**
 * Face-shape analysis.
 *
 * Pipeline, in order:
 *   1. FACE-LOCAL FRAME  — measurements are taken along the face's own up-axis
 *                          (chin→forehead) and its perpendicular, so head roll
 *                          doesn't distort widths.
 *   2. CONTOUR PROFILING — the face-oval silhouette is resampled into a
 *                          width-vs-height profile; the WIDEST POINT is found
 *                          by search, and the forehead is extrapolated up to
 *                          the hairline (the mesh stops below it).
 *   3. POSE GATING       — yaw / roll / pitch outliers are dropped.
 *   4. FRAME AVERAGING   — accepted frames reduce by MEDIAN over ~30 frames.
 *   5. SCORING           — the eight measured proportions are matched against
 *                          each shape's canonical anthropometric ratios.
 *
 * A NOTE ON HOW THE PROTOTYPES WERE SET
 * -------------------------------------
 * These come from the canonical descriptions of each shape (face length ~1.5x
 * width for Oval, forehead ≈ cheeks ≈ jaw for Square, cheekbones widest for
 * Diamond, and so on), NOT from fitting a photo set. Two rounds of fitting were
 * tried against 16 labeled photos and both were rejected: the fitted values
 * produced a near-constant classifier that returned one shape for almost every
 * face, because that sample is small, its labels are unverified, and the
 * within-class spread there exceeds the between-class spread on every feature.
 *
 * Consequence to be aware of: `scripts/test-face-shape.mjs` scores this version
 * poorly (~8% top-1) against that same fixture. That number is retained
 * deliberately as a signal about the FIXTURE, not a verdict on the model —
 * live scanning of real faces has been noticeably better with these
 * proportion-based values than with anything fitted to those photos.
 */

/** Minimal shape of a MediaPipe normalized landmark. */
interface NormalizedPoint {
  x: number;
  y: number;
  z?: number;
}

// ---------------------------------------------------------------------------
// Landmark indices (MediaPipe Face Landmarker, 478-point model)
// ---------------------------------------------------------------------------

const IDX = {
  foreheadTop: 10,
  chinBottom: 152,
  glabella: 9, // between the brows
  subnasale: 2, // base of the nose
  chinLeft: 149,
  chinRight: 378,
  // Jaw corner (gonion) + its neighbours, for the jaw angle.
  gonionR: 172,
  gonionRUp: 132,
  gonionL: 397,
  gonionLUp: 361,
  // Pose reference.
  eyeOuterLeft: 33,
  eyeOuterRight: 263,
  noseTip: 1,
} as const;

/**
 * The two halves of the face-oval silhouette, both running chin → forehead.
 * Walking these gives a continuous outline we can sample at any height.
 */
const OVAL_RIGHT = [
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10,
];
const OVAL_LEFT = [
  152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454, 356, 389, 251, 284, 332, 297, 338, 10,
];

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** How many accepted frames to average before a reading is considered settled. */
export const TARGET_SAMPLES = 30;

/** Ring buffer cap (keeps the most recent readings). */
const MAX_SAMPLES = 45;

/** Top-2 within this confidence gap ⇒ report a blend rather than a winner. */
const BLEND_GAP = 0.08;

/** Pose gates — frames outside these are dropped, not classified. */
const POSE_LIMITS = {
  maxYawAsymmetry: 0.14,
  maxRollDegrees: 12,
  minPitchBalance: 0.55,
  maxPitchBalance: 1.75,
};

/**
 * Heights (0 = chin, 1 = forehead-top landmark) at which the profile is read.
 * The mesh stops below the hairline, so forehead width is extrapolated from the
 * trend between the two upper samples.
 */
const H_JAW = 0.26;
const H_FORE_LOW = 0.72;
const H_FORE_HIGH = 0.88;
/** Fraction of face length the real hairline sits above landmark 10. */
const HAIRLINE_LIFT = 0.13;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

interface Vec {
  x: number;
  y: number;
}

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;

/**
 * Sample a contour chain's lateral offset at a given normalized height.
 * The chain runs chin→forehead; heights are monotonic enough to interpolate.
 */
function lateralAt(chain: { h: number; w: number }[], targetH: number): number {
  if (targetH <= chain[0].h) return chain[0].w;
  const last = chain[chain.length - 1];
  if (targetH >= last.h) return last.w;
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1];
    const b = chain[i];
    if (targetH >= a.h && targetH <= b.h) {
      const span = b.h - a.h;
      const t = span < 1e-6 ? 0 : (targetH - a.h) / span;
      return a.w + (b.w - a.w) * t;
    }
  }
  return last.w;
}

// ---------------------------------------------------------------------------
// Feature vector
// ---------------------------------------------------------------------------

/**
 * The eight proportions every decision is made from. All are ratios, so
 * distance from the camera cancels out.
 */
export interface FaceRatios {
  /** Face length ÷ mean zone width. High = long face. */
  elongation: number;
  /** Forehead width ÷ mean zone width. High = top-heavy (Heart). */
  foreheadRel: number;
  /** Cheekbone width ÷ mean zone width. High = mid-heavy (Diamond). */
  cheekRel: number;
  /** Jaw width ÷ mean zone width. High = bottom-heavy (Triangle). */
  jawRel: number;
  /** Height of the widest point: 0 = at the forehead, 1 = at the jaw. */
  widestZone: number;
  /** Jaw (gonial) angle in degrees. Low ≈ 100° = boxy; high ≈ 135° = soft. */
  jawAngle: number;
  /** Chin width ÷ jaw width. Low = sharply pointed chin. */
  chinTaper: number;
  /** Upper third ÷ lower third of the face. */
  thirdsRatio: number;
}

/** Per-frame measurements plus pose diagnostics. */
export interface FrameMetrics extends FaceRatios {
  faceLength: number;
  foreheadWidth: number;
  cheekWidth: number;
  jawWidth: number;
  yawAsymmetry: number;
  rollDegrees: number;
  pitchBalance: number;
}

/**
 * Measure one frame.
 *
 * Everything is computed in the face's own frame: `U` points chin→forehead and
 * `V` is perpendicular, so a tilted head yields the same numbers as a level one.
 */
export function measureFrame(
  landmarks: NormalizedPoint[],
  width: number,
  height: number,
): FrameMetrics {
  // Landmarks are normalized to width/height separately — scale to pixels
  // before mixing horizontal and vertical distances.
  const px = (i: number): Vec => ({
    x: landmarks[i].x * width,
    y: landmarks[i].y * height,
  });

  const chin = px(IDX.chinBottom);
  const brow = px(IDX.foreheadTop);
  const axis = sub(brow, chin);
  const faceLength = Math.hypot(axis.x, axis.y) || 1e-6;
  const U: Vec = { x: axis.x / faceLength, y: axis.y / faceLength };
  const V: Vec = { x: -U.y, y: U.x };

  /** Project a landmark into (height 0–1 from chin, lateral offset). */
  const project = (i: number) => {
    const d = sub(px(i), chin);
    return { h: dot(d, U) / faceLength, w: dot(d, V) };
  };

  const right = OVAL_RIGHT.map(project);
  const left = OVAL_LEFT.map(project);
  const widthAt = (h: number) => Math.abs(lateralAt(left, h) - lateralAt(right, h));

  // ---- widest-point search (not assumed to be the cheekbone) -------------
  let widestH = 0.5;
  let cheekWidth = 0;
  for (let s = 0; s <= 60; s++) {
    const h = 0.15 + (0.75 * s) / 60; // scan jaw → upper forehead
    const w = widthAt(h);
    if (w > cheekWidth) {
      cheekWidth = w;
      widestH = h;
    }
  }
  // Report 0 at the forehead and 1 at the jaw (reads naturally in prototypes).
  const scanLo = 0.15;
  const scanHi = 0.9;
  const widestZone = Math.min(1, Math.max(0, (scanHi - widestH) / (scanHi - scanLo)));

  const jawWidth = widthAt(H_JAW);

  // ---- hairline-extrapolated forehead ------------------------------------
  // The mesh stops below the hairline, so project the upper contour's trend
  // up to the real hairline. Clamped so noise can't invent a huge forehead.
  const wLow = widthAt(H_FORE_LOW);
  const wHigh = widthAt(H_FORE_HIGH);
  const slope = (wHigh - wLow) / (H_FORE_HIGH - H_FORE_LOW);
  const hairlineH = 1 + HAIRLINE_LIFT;
  const foreheadWidth = Math.min(
    cheekWidth * 1.05,
    Math.max(wHigh * 0.75, wHigh + slope * (hairlineH - H_FORE_HIGH) * 0.5),
  );

  // ---- zone proportions ---------------------------------------------------
  const meanWidth = (foreheadWidth + cheekWidth + jawWidth) / 3 || 1e-6;

  // ---- jaw (gonial) angle, averaged across both sides --------------------
  const angleAt = (corner: number, up: number) => {
    const c = px(corner);
    const a = sub(px(up), c);
    const b = sub(chin, c);
    const na = Math.hypot(a.x, a.y) || 1e-6;
    const nb = Math.hypot(b.x, b.y) || 1e-6;
    const cos = Math.min(1, Math.max(-1, dot(a, b) / (na * nb)));
    return (Math.acos(cos) * 180) / Math.PI;
  };
  const jawAngle =
    (angleAt(IDX.gonionR, IDX.gonionRUp) + angleAt(IDX.gonionL, IDX.gonionLUp)) / 2;

  // ---- facial thirds (measured along the face axis) ----------------------
  const hOf = (i: number) => dot(sub(px(i), chin), U) / faceLength;
  const upperThird = Math.max(1e-6, hairlineH - hOf(IDX.glabella));
  const lowerThird = Math.max(1e-6, hOf(IDX.subnasale));
  const thirdsRatio = upperThird / lowerThird;

  // ---- chin taper --------------------------------------------------------
  const chinWidth = Math.abs(
    dot(sub(px(IDX.chinLeft), chin), V) - dot(sub(px(IDX.chinRight), chin), V),
  );

  // ---- pose diagnostics --------------------------------------------------
  const noseX = px(IDX.noseTip).x;
  const dLeft = Math.abs(noseX - px(IDX.eyeOuterLeft).x);
  const dRight = Math.abs(px(IDX.eyeOuterRight).x - noseX);
  const yawAsymmetry = Math.abs(dLeft - dRight) / Math.max(dLeft + dRight, 1e-6);

  const eyeD = sub(px(IDX.eyeOuterRight), px(IDX.eyeOuterLeft));
  const rollDegrees = Math.abs((Math.atan2(eyeD.y, eyeD.x) * 180) / Math.PI);

  const upper = Math.abs(px(IDX.noseTip).y - px(IDX.foreheadTop).y);
  const lower = Math.abs(px(IDX.chinBottom).y - px(IDX.noseTip).y);
  const pitchBalance = upper / Math.max(lower, 1e-6);

  return {
    faceLength,
    foreheadWidth,
    cheekWidth,
    jawWidth,
    elongation: faceLength / meanWidth,
    foreheadRel: foreheadWidth / meanWidth,
    cheekRel: cheekWidth / meanWidth,
    jawRel: jawWidth / meanWidth,
    widestZone,
    jawAngle,
    chinTaper: chinWidth / Math.max(jawWidth, 1e-6),
    thirdsRatio,
    yawAsymmetry,
    rollDegrees,
    pitchBalance,
  };
}

/** True when the head is frontal enough for the widths to be trustworthy. */
export function isPoseAcceptable(m: FrameMetrics): boolean {
  return (
    m.yawAsymmetry <= POSE_LIMITS.maxYawAsymmetry &&
    m.rollDegrees <= POSE_LIMITS.maxRollDegrees &&
    m.pitchBalance >= POSE_LIMITS.minPitchBalance &&
    m.pitchBalance <= POSE_LIMITS.maxPitchBalance
  );
}

// ---------------------------------------------------------------------------
// Prototype scoring
// ---------------------------------------------------------------------------

/** Per-feature tolerance (σ). Smaller ⇒ that feature discriminates harder. */
const SIGMA: FaceRatios = {
  elongation: 0.15,
  foreheadRel: 0.055,
  cheekRel: 0.055,
  jawRel: 0.055,
  widestZone: 0.22,
  jawAngle: 13,
  chinTaper: 0.15,
  thirdsRatio: 0.16,
};

/** How much each feature counts toward the match. */
const WEIGHT: FaceRatios = {
  elongation: 1.25,
  foreheadRel: 1.1,
  cheekRel: 0.9,
  jawRel: 1.1,
  widestZone: 1.15,
  jawAngle: 1.0,
  chinTaper: 0.8,
  thirdsRatio: 0.5,
};

/**
 * Ideal proportions per shape, from the canonical descriptions.
 *
 * Read them as: Oval is longer than wide with a softly tapering jaw; Round is
 * short with soft edges; Square/Rectangle share a strong jaw and differ only in
 * length; Heart is forehead-heavy with a pointed chin; Diamond peaks at the
 * cheekbones with BOTH forehead and jaw narrow; Triangle is the inverse of
 * Heart — narrow forehead, widest at the jaw.
 *
 * `foreheadRel + cheekRel + jawRel` ≈ 3 by construction, so those three read as
 * the face's width *profile*: which zone dominates.
 */
const PROTOTYPES: Record<FaceShape, FaceRatios> = {
  Oval: {
    elongation: 1.45, foreheadRel: 0.97, cheekRel: 1.05, jawRel: 0.98,
    widestZone: 0.45, jawAngle: 126, chinTaper: 0.56, thirdsRatio: 1.0,
  },
  Round: {
    elongation: 1.14, foreheadRel: 0.96, cheekRel: 1.09, jawRel: 0.95,
    widestZone: 0.48, jawAngle: 132, chinTaper: 0.66, thirdsRatio: 1.0,
  },
  Square: {
    elongation: 1.2, foreheadRel: 1.0, cheekRel: 1.02, jawRel: 0.98,
    widestZone: 0.6, jawAngle: 101, chinTaper: 0.83, thirdsRatio: 1.0,
  },
  Rectangle: {
    elongation: 1.6, foreheadRel: 1.0, cheekRel: 1.02, jawRel: 0.98,
    widestZone: 0.6, jawAngle: 105, chinTaper: 0.8, thirdsRatio: 1.08,
  },
  Heart: {
    elongation: 1.42, foreheadRel: 1.08, cheekRel: 1.02, jawRel: 0.9,
    widestZone: 0.14, jawAngle: 134, chinTaper: 0.42, thirdsRatio: 0.94,
  },
  Diamond: {
    elongation: 1.52, foreheadRel: 0.92, cheekRel: 1.15, jawRel: 0.93,
    widestZone: 0.46, jawAngle: 130, chinTaper: 0.47, thirdsRatio: 1.0,
  },
  Triangle: {
    elongation: 1.36, foreheadRel: 0.9, cheekRel: 1.02, jawRel: 1.08,
    widestZone: 0.85, jawAngle: 112, chinTaper: 0.76, thirdsRatio: 1.06,
  },
};

const FEATURES = [
  "elongation",
  "foreheadRel",
  "cheekRel",
  "jawRel",
  "widestZone",
  "jawAngle",
  "chinTaper",
  "thirdsRatio",
] as const;

// ---------------------------------------------------------------------------
// Scale alignment
// ---------------------------------------------------------------------------

/**
 * What `measureFrame` actually emits, averaged over a population of real faces.
 *
 * The prototypes above are written on the TEXTBOOK scale, which is not the scale
 * this code measures on. Some are wildly apart — prototype `cheekRel` averages
 * 1.05 where measurement averages 1.14 (9σ away), `jawAngle` 120° vs 145° (5σ),
 * `widestZone` 0.51 vs 0.27 (4.7σ).
 *
 * Left uncorrected this is fatal: whichever prototype happens to sit nearest the
 * measured average wins for EVERY face, which is why earlier builds returned
 * "Heart" for everyone, then "Square", then a flood of "Triangle"/"Diamond".
 */
const MEASURED_MEAN: FaceRatios = {
  elongation: 1.35, foreheadRel: 0.94, cheekRel: 1.14, jawRel: 0.91,
  widestZone: 0.27, jawAngle: 144.9, chinTaper: 0.53, thirdsRatio: 0.91,
};
const MEASURED_SD: FaceRatios = {
  elongation: 0.07, foreheadRel: 0.05, cheekRel: 0.012, jawRel: 0.05,
  widestZone: 0.05, jawAngle: 4.92, chinTaper: 0.02, thirdsRatio: 0.08,
};

/**
 * Re-express the prototypes on the measurement scale.
 *
 * Per feature, the prototype set is shifted and stretched so its centre and
 * spread match the measured population's. This changes NOTHING about the
 * anatomy: every shape keeps its exact relative position — Diamond still has
 * the widest cheeks, Heart the widest forehead, Square the boxiest jaw — the
 * numbers are simply moved into the range the code speaks in. Sigma is scaled
 * the same way so tolerances stay proportional.
 */
function alignToMeasuredScale(): { protos: Record<FaceShape, FaceRatios>; sigma: FaceRatios } {
  const shapes = Object.keys(PROTOTYPES) as FaceShape[];
  const protos = {} as Record<FaceShape, FaceRatios>;
  for (const s of shapes) protos[s] = { ...PROTOTYPES[s] };
  const sigma = { ...SIGMA };

  for (const f of FEATURES) {
    const vals = shapes.map((s) => PROTOTYPES[s][f]);
    const pMean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const pSd =
      Math.sqrt(vals.reduce((a, v) => a + (v - pMean) ** 2, 0) / vals.length) || 1e-6;
    const gain = MEASURED_SD[f] / pSd;
    for (const s of shapes) {
      protos[s][f] = MEASURED_MEAN[f] + (PROTOTYPES[s][f] - pMean) * gain;
    }
    sigma[f] = SIGMA[f] * gain;
  }
  return { protos, sigma };
}

const { protos: ALIGNED_PROTOTYPES, sigma: ALIGNED_SIGMA } = alignToMeasuredScale();

/**
 * Shapes whose definition rests on one zone being *the widest part of the face*.
 *
 * Plenty of faces have a somewhat wider jaw without being Triangles, and a
 * somewhat broader forehead without being Hearts. Distance-based scoring alone
 * over-fires on these, because "a bit wider than average" already sits closer to
 * the Triangle prototype than to anything else. So these shapes must clear a
 * DOMINANCE BAR before they can win: the defining zone has to stand out by
 * `minZ` standard deviations above the population, not merely lean that way.
 *
 * The gate is a smooth sigmoid, not a hard cut — a face right at the bar is
 * damped rather than eliminated, so nothing snaps between shapes frame to frame.
 */
const DOMINANCE_GATE: Partial<
  Record<
    FaceShape,
    {
      feature: keyof FaceRatios;
      minZ: number;
      soft: number;
      /** An alternative way to qualify — the gate opens if EITHER bar is met. */
      or?: { feature: keyof FaceRatios; minZ: number };
    }
  >
> = {
  // Jaw must be emphatically the widest zone. This bar is set high on purpose:
  // plenty of faces carry a somewhat wide jaw without being Triangles, and
  // distance scoring alone hands those to Triangle far too readily.
  Triangle: { feature: "jawRel", minZ: 1.25, soft: 0.45 },
  // Mirror case: forehead must genuinely dominate.
  Heart: { feature: "foreheadRel", minZ: 0.75, soft: 0.45 },
  // Cheekbones must genuinely peak — OR the jaw is wide enough that Triangle is
  // in play, in which case Diamond is a strong alternative reading of the same
  // face (both are strong-bone-structure shapes) and must stay in contention.
  Diamond: {
    feature: "cheekRel",
    minZ: 0.55,
    soft: 0.45,
    or: { feature: "jawRel", minZ: 0.85 },
  },
};

/** How strongly a shape's defining zone stands out, 0–1 (1 = clearly dominant). */
function dominanceFactor(shape: FaceShape, ratios: FaceRatios): number {
  const gate = DOMINANCE_GATE[shape];
  if (!gate) return 1;

  const open = (feature: keyof FaceRatios, minZ: number) => {
    const z = (ratios[feature] - MEASURED_MEAN[feature]) / MEASURED_SD[feature];
    return 1 / (1 + Math.exp(-(z - minZ) / gate.soft));
  };

  const primary = open(gate.feature, gate.minZ);
  // Either route can open the gate, so take whichever is more permissive.
  return gate.or ? Math.max(primary, open(gate.or.feature, gate.or.minZ)) : primary;
}

/**
 * Softmax temperature. With eight features the raw distances get large, so this
 * keeps a good match around 60–80% instead of pinning it at ~100% and hiding
 * every near-tie.
 */
const TEMPERATURE = 3.2;

/** One shape's match against the measured face. */
export interface FaceShapeScore {
  shape: FaceShape;
  /** Raw similarity to that shape's proportions, 0–1 (1 = exact match). */
  score: number;
  /** Share of total similarity across all seven shapes, 0–1. */
  confidence: number;
}

/**
 * Score the measured proportions against every shape.
 *
 * Weighted squared z-distance through a Gaussian: a perfect match scores 1 and
 * similarity decays smoothly. No thresholds and no dead zones — every face gets
 * a full ranking.
 */
export function scoreRatios(ratios: FaceRatios): FaceShapeScore[] {
  const raw = (Object.keys(ALIGNED_PROTOTYPES) as FaceShape[]).map((shape) => {
    const proto = ALIGNED_PROTOTYPES[shape];
    // Weighted SUM (not mean) of squared z-scores: every off-spec feature adds
    // to the distance, so a good match stays clearly separated from the rest.
    let dist2 = 0;
    for (const f of FEATURES) {
      const z = (ratios[f] - proto[f]) / ALIGNED_SIGMA[f];
      dist2 += WEIGHT[f] * z * z;
    }
    // Shapes defined by a dominant zone are damped unless it really dominates.
    const score = Math.exp(-dist2 / (2 * TEMPERATURE)) * dominanceFactor(shape, ratios);
    return { shape, score };
  });

  const sum = raw.reduce((acc, r) => acc + r.score, 0) || 1;
  return raw
    .map((r) => ({ ...r, confidence: r.score / sum }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Public result
// ---------------------------------------------------------------------------

export interface FaceShapeResult {
  /** Best match. */
  shape: FaceShape;
  /** All seven shapes, best first. */
  ranked: FaceShapeScore[];
  /** Second-best match, surfaced for the UI. */
  runnerUp: FaceShapeScore | null;
  /**
   * Set when the top two are within BLEND_GAP — the reading is genuinely
   * between two shapes and forcing one would overstate the model's certainty.
   */
  blendLabel: string | null;
  /** Shapes offered in the confirm step, best-scoring first. */
  candidates: FaceShape[];
  /** Coarse length reading, shown as context alongside the guess. */
  lengthClass: "compact" | "elongated";
  /** The averaged proportions the ranking came from. */
  ratios: FaceRatios;
  /** How many pose-accepted frames were averaged (1 for a single-frame call). */
  samples: number;
}

/** Median — robust to the occasional bad frame in a way a mean is not. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function buildResult(ratios: FaceRatios, samples: number): FaceShapeResult {
  const ranked = scoreRatios(ratios);
  const [top, second] = ranked;
  const isBlend = !!second && top.confidence - second.confidence < BLEND_GAP;

  return {
    shape: top.shape,
    ranked,
    runnerUp: second ?? null,
    blendLabel: isBlend ? `${top.shape}–${second.shape}` : null,
    // Offer the four strongest so the user can correct a near-miss without
    // scrolling the full list; the rest stay behind "none of these?".
    candidates: ranked.slice(0, 4).map((r) => r.shape),
    lengthClass: ratios.elongation >= 1.4 ? "elongated" : "compact",
    ratios,
    samples,
  };
}

// ---------------------------------------------------------------------------
// Sampler — pose-gated frame averaging
// ---------------------------------------------------------------------------

export interface FaceShapeSampler {
  /** Feed one frame. Returns true if it passed the pose gate. */
  addFrame(landmarks: NormalizedPoint[], width: number, height: number): boolean;
  /** Accepted frames collected so far. */
  count(): number;
  /** 0–1 progress toward TARGET_SAMPLES. */
  progress(): number;
  /** Enough frames for a settled reading. */
  isReady(): boolean;
  /** Classify from the averaged proportions; null if nothing was accepted. */
  classify(): FaceShapeResult | null;
  reset(): void;
}

/**
 * Collects pose-acceptable frames and classifies from their median proportions.
 *
 * Feed it every tracked frame during calibration; frames where the head is
 * turned or tilted are dropped silently, so the final reading reflects a
 * frontal face even if the user moved while lining up.
 */
export function createFaceShapeSampler(): FaceShapeSampler {
  let samples: FaceRatios[] = [];

  return {
    addFrame(landmarks, width, height) {
      if (!landmarks || landmarks.length < 468) return false;
      const m = measureFrame(landmarks, width, height);
      if (!Number.isFinite(m.elongation) || !isPoseAcceptable(m)) return false;

      const row = {} as FaceRatios;
      for (const f of FEATURES) row[f] = m[f];
      samples.push(row);
      if (samples.length > MAX_SAMPLES) samples.shift();
      return true;
    },

    count: () => samples.length,
    progress: () => Math.min(1, samples.length / TARGET_SAMPLES),
    isReady: () => samples.length >= TARGET_SAMPLES,

    classify() {
      if (samples.length === 0) return null;
      const averaged = {} as FaceRatios;
      for (const f of FEATURES) averaged[f] = median(samples.map((s) => s[f]));
      return buildResult(averaged, samples.length);
    },

    reset() {
      samples = [];
    },
  };
}

/**
 * Single-frame classification.
 *
 * Kept for callers holding one frame (and as the sampler's fallback), but
 * prefer `createFaceShapeSampler` — a lone frame is pose-sensitive, which is
 * exactly the weakness the sampler exists to fix.
 */
export function classifyFaceShape(
  landmarks: NormalizedPoint[],
  width: number,
  height: number,
): FaceShapeResult {
  const m = measureFrame(landmarks, width, height);
  const row = {} as FaceRatios;
  for (const f of FEATURES) row[f] = m[f];
  return buildResult(row, 1);
}
