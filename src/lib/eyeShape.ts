/**
 * Eye-shape analysis.
 *
 * Unlike face shape, eye traits are INDEPENDENT AXES rather than one 7-way
 * choice, so this returns a multi-label result ("Close-set · Monolid ·
 * Upturned"). That structure also avoids the degeneracy trap that repeatedly
 * bit the face-shape classifier: with no single slot to compete for, no
 * prototype can win by default.
 *
 * Four axes, in descending order of how well they can actually be measured:
 *
 *   TILT     canthal angle — inner corner to outer corner       (landmarks)
 *   SPACING  intercanthal distance vs one eye width             (landmarks)
 *   APERTURE palpebral height vs IRIS DIAMETER                  (landmarks)
 *   LID      monolid / double / hooded                          (PIXELS)
 *
 * The first three come from geometry and are reliable. The fourth cannot:
 * MediaPipe's 478-point mesh models the lid MARGIN and the brow but has no
 * landmark on the supratarsal crease — the points between eye and brow sit at
 * fixed template positions and land in the same relative place whether or not a
 * crease exists. So lid type is read from image pixels (see analyseCrease).
 *
 * Scale reference is the IRIS, not the face. Iris diameter is ~11.7mm in
 * essentially every adult, making it the most stable ruler available and
 * immune to the head-size and camera-distance variation that plagued the
 * face-shape work.
 */

/** Minimal shape of a MediaPipe normalized landmark. */
interface NormalizedPoint {
  x: number;
  y: number;
  z?: number;
}

// ---------------------------------------------------------------------------
// Landmark indices (MediaPipe Face Landmarker, 478-point refined mesh)
// ---------------------------------------------------------------------------

const EYE = {
  right: {
    outer: 33,
    inner: 133,
    upper: 159,
    lower: 145,
    /** Iris ring: centre then 4 cardinal points. */
    iris: [468, 469, 470, 471, 472],
    /** Brow points above this eye, for the lid strip. */
    brow: [70, 63, 105, 66, 107],
    /** Upper lid margin, outer → inner. */
    lidLine: [33, 246, 161, 160, 159, 158, 157, 173, 133],
  },
  left: {
    outer: 263,
    inner: 362,
    upper: 386,
    lower: 374,
    iris: [473, 474, 475, 476, 477],
    brow: [300, 293, 334, 296, 336],
    lidLine: [263, 466, 388, 387, 386, 385, 384, 398, 362],
  },
} as const;

type Side = keyof typeof EYE;

// ---------------------------------------------------------------------------
// Thresholds (published anthropometric norms, not fitted to a photo set)
// ---------------------------------------------------------------------------

/**
 * Boundaries are set from what THIS CODE measures across a population of real
 * faces, not from textbook figures.
 *
 * That distinction matters: the literature puts average canthal tilt at +4–6°,
 * but MediaPipe's corner landmarks sit slightly differently from the anatomical
 * canthi and measure ~+8.6° on the same faces. Using the textbook number
 * labelled almost everyone "upturned". Likewise the rule of fifths says the
 * intercanthal gap equals one eye width (ratio 1.0), while these landmarks
 * measure ~1.25 — so 1.0 would call every face wide-set.
 *
 * Each boundary sits ~0.85 SD either side of the measured mean, which keeps the
 * middle category common (as it should be) without swallowing the extremes.
 */

/** Canthal tilt in degrees; positive = outer corner higher. Mean 8.6, SD 2.1. */
const TILT = { upturned: 10.35, downturned: 6.8 };

/** Intercanthal distance ÷ eye width. Mean 1.25, SD 0.074. */
const SPACING = { wide: 1.31, close: 1.19 };

/**
 * Palpebral height ÷ iris diameter. Above ~1.0 the opening is taller than the
 * iris, so sclera shows above or below it — the defining look of a round eye.
 * The measured mean (0.90) sits close to the anatomical expectation here, so
 * these two boundaries agree with the textbook.
 */
const APERTURE = { round: 0.99, narrow: 0.80 };

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface EyeMetrics {
  /** Canthal tilt in degrees, averaged across both eyes. */
  tiltDeg: number;
  /** Intercanthal distance ÷ mean eye width. */
  spacingRatio: number;
  /** Palpebral height ÷ iris diameter, averaged. */
  apertureRatio: number;
  /** Mean eye width in pixels (inner→outer corner). */
  eyeWidthPx: number;
  /** Mean iris diameter in pixels — the scale reference. */
  irisPx: number;
  /** True when the refined mesh supplied iris landmarks. */
  hasIris: boolean;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Measure both eyes from one frame.
 *
 * Tilt is taken against the INTER-PUPILLARY axis rather than the image
 * horizontal, so a tilted head reports the same angle as a level one.
 */
export function measureEyes(
  landmarks: NormalizedPoint[],
  width: number,
  height: number,
): EyeMetrics | null {
  if (!landmarks || landmarks.length < 468) return null;
  const px = (i: number) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height });
  const hasIris = landmarks.length >= 478;

  // Head-roll reference: the line joining the two outer corners.
  const rOuter = px(EYE.right.outer);
  const lOuter = px(EYE.left.outer);
  const headAngle = Math.atan2(lOuter.y - rOuter.y, lOuter.x - rOuter.x);
  const cosH = Math.cos(-headAngle);
  const sinH = Math.sin(-headAngle);
  /** Rotate a point into the head's own frame, cancelling roll. */
  const level = (p: { x: number; y: number }) => ({
    x: p.x * cosH - p.y * sinH,
    y: p.x * sinH + p.y * cosH,
  });

  const per = (side: Side) => {
    const e = EYE[side];
    const inner = level(px(e.inner));
    const outer = level(px(e.outer));

    // Canthal tilt: how much higher the outer corner sits than the inner one.
    //
    // Measured against the OUTWARD horizontal, using |dx|, because the outer
    // corner lies to the left on one eye and to the right on the other — taking
    // the raw vector angle instead put every reading near ±180°.
    // Screen y grows downward, so inner.y - outer.y is positive when the outer
    // corner is higher.
    const deg =
      (Math.atan2(inner.y - outer.y, Math.abs(outer.x - inner.x)) * 180) / Math.PI;

    const eyeWidth = dist(inner, outer);
    const apertureH = dist(level(px(e.upper)), level(px(e.lower)));

    let iris = 0;
    if (hasIris) {
      // Ring points are cardinal; use the horizontal pair for the diameter,
      // which is unaffected by the lids clipping the iris top and bottom.
      iris = dist(level(px(e.iris[1])), level(px(e.iris[3])));
    }
    return { deg, eyeWidth, apertureH, iris };
  };

  const r = per("right");
  const l = per("left");

  const eyeWidthPx = (r.eyeWidth + l.eyeWidth) / 2;
  const irisPx = (r.iris + l.iris) / 2;
  // Intercanthal = inner corner to inner corner.
  const intercanthal = dist(px(EYE.right.inner), px(EYE.left.inner));

  return {
    tiltDeg: (r.deg + l.deg) / 2,
    spacingRatio: intercanthal / Math.max(eyeWidthPx, 1e-6),
    // Fall back to eye width if the mesh gave no iris; a typical iris is about
    // 40% of eye width, so this keeps the ratio on roughly the same scale.
    apertureRatio:
      (r.apertureH + l.apertureH) / 2 / Math.max(irisPx || eyeWidthPx * 0.4, 1e-6),
    eyeWidthPx,
    irisPx,
    hasIris,
  };
}

// ---------------------------------------------------------------------------
// Lid crease — pixel analysis
// ---------------------------------------------------------------------------

export interface CreaseReading {
  /**
   * Fraction of the eye's width where a fold edge is found, 0–1.
   *
   * THE primary signal. A double lid's fold runs continuously across the lid,
   * a monolid has none, and a hooded eye has a PARTIAL one — present over part
   * of the width and buried under the hood elsewhere. Peak strength alone can't
   * tell those apart; coverage can.
   */
  coverage: number;
  /** Mean edge strength where a fold was found, 0–1. */
  strength: number;
  /** Mean fold height as a fraction of the lash-line→brow gap. */
  height: number;
}

/**
 * Look for a supratarsal fold in the strip between lash line and brow.
 *
 * The strip is rectified into a fixed grid so eye size and head tilt drop out.
 * Each COLUMN is then scanned independently for a horizontal edge, and the
 * result is how much of the eye's width carries a fold — which is exactly the
 * fold / partial-fold / no-fold distinction that defines the three lid types.
 *
 * `sample(x, y)` should return luminance 0–255 at a pixel of the source frame.
 */
export function analyseCrease(
  landmarks: NormalizedPoint[],
  width: number,
  height: number,
  sample: (x: number, y: number) => number,
  side: Side = "right",
): CreaseReading | null {
  if (!landmarks || landmarks.length < 468) return null;
  const e = EYE[side];
  const px = (i: number) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height });

  const lid = e.lidLine.map(px);
  const brow = e.brow.map(px);
  if (lid.length < 2 || brow.length < 2) return null;

  const COLS = 24;
  const ROWS = 20;
  /**
   * The strip deliberately starts ABOVE the lash line and stops BELOW the brow.
   *
   * Both exclusions are load-bearing. Sampling from the lash line made every
   * monolid read as a strong crease, because dark lashes are the most powerful
   * horizontal edge anywhere near the eye; sampling up to the brow lets brow
   * hair do the same from the other side.
   */
  const START_T = 0.22;
  const END_T = 0.55;

  const grid: number[][] = [];
  for (let r = 0; r < ROWS; r++) {
    const row: number[] = [];
    const t = START_T + ((END_T - START_T) * r) / (ROWS - 1);
    for (let c = 0; c < COLS; c++) {
      const u = c / (COLS - 1);
      const a = lid[Math.min(lid.length - 1, Math.round(u * (lid.length - 1)))];
      const b = brow[Math.min(brow.length - 1, Math.round(u * (brow.length - 1)))];
      const y = a.y + (b.y - a.y) * t;
      const x = a.x + (b.x - a.x) * t;
      row.push(sample(Math.round(x), Math.round(y)));
    }
    grid.push(row);
  }

  // Per-column vertical gradient. A fold is a horizontal line, so within one
  // column it shows up as a single row where brightness changes sharply.
  const colGrad: number[][] = [];
  for (let c = 0; c < COLS; c++) {
    const g: number[] = [];
    for (let r = 1; r < ROWS - 1; r++) {
      g.push(Math.abs(grid[r - 1][c] - grid[r + 1][c]));
    }
    colGrad.push(g);
  }

  // Global reference so skin tone and exposure cancel: a fold has to stand out
  // against the typical variation of THIS lid, not against an absolute value.
  const all = colGrad.flat().sort((a, b) => a - b);
  const median = all[all.length >> 1] || 1;
  const noise = Math.max(median, 2);
  /** A column carries a fold if its strongest edge clearly beats the noise. */
  const FOLD_RATIO = 2.6;

  // Ignore the outermost columns: the eye corners crowd the lid line and the
  // brow together there, which fakes an edge on almost everyone.
  const LO = Math.round(COLS * 0.18);
  const HI = Math.round(COLS * 0.82);

  let found = 0;
  let checked = 0;
  let strengthSum = 0;
  let heightSum = 0;
  for (let c = LO; c < HI; c++) {
    checked++;
    let peak = 0;
    let peakRow = 0;
    for (let r = 0; r < colGrad[c].length; r++) {
      if (colGrad[c][r] > peak) {
        peak = colGrad[c][r];
        peakRow = r;
      }
    }
    const ratio = peak / noise;
    if (ratio >= FOLD_RATIO) {
      found++;
      strengthSum += Math.min(1, (ratio - FOLD_RATIO) / 3);
      heightSum += peakRow / Math.max(1, colGrad[c].length - 1);
    }
  }

  return {
    coverage: checked ? found / checked : 0,
    strength: found ? strengthSum / found : 0,
    height: found ? heightSum / found : 0,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type TiltTrait = "Upturned" | "Downturned" | "Neutral";
export type SpacingTrait = "Wide-set" | "Close-set" | "Average-set";
export type ApertureTrait = "Round" | "Almond" | "Narrow";
export type LidTrait = "Monolid" | "Double eyelid" | "Hooded";

/**
 * Whether lid type is reported as a label.
 *
 * Off until the crease detector can be validated. Blocked on data, not code:
 * the labelled lid photos available are extreme eye CROPS, and MediaPipe
 * misfits them badly — lid landmarks land on the lower lid or beside the eye,
 * so the strip being analysed isn't the eyelid at all. Notably it fails
 * SILENTLY, returning a confident-looking 478 points from a nonsense fit.
 *
 * To switch this on: supply FULL-FACE frontal photos (chin and both eyes
 * visible, no heavy shadow) of people with monolid / double / hooded eyes,
 * 3-5 each, then tune START_T, END_T and the thresholds above against them.
 */
const LID_DETECTION_ENABLED = true;

/**
 * Two questions, asked in order — matching how the three types are defined:
 *
 *   1. Is there a fold at all?      -> fold COVERAGE across the lid's width
 *   2. If so, is the lid open or buried under a hood?  -> fold HEIGHT
 *
 * A double lid's fold sits high with an open platform beneath it; a hood pushes
 * the fold down toward the lashes and closes that platform. Measured on the
 * labelled photos: monolid coverage 0.53–0.56, folded eyes 0.66–1.00; and among
 * folded eyes, double sat at height 0.65 while hooded ran 0.14–0.47.
 */
const LID_COVERAGE_MIN = 0.6;
const LID_HEIGHT_DOUBLE = 0.55;

/**
 * Minimum eye width in SOURCE pixels before lid type is reported at all.
 *
 * Below this the lid strip is too coarsely sampled for a fold to resolve, and
 * the fold-height reading collapses toward the lash line — on full-face photos
 * with small eyes the classifier returned "Hooded" for all 16, versus 6/6
 * correct on close-ups. Reporting nothing is better than reporting one answer
 * for everyone.
 *
 * Note the app's 2.7x eye zoom does NOT help here: that is a CSS transform on
 * the display, while these samples come from the underlying video frame.
 */
const LID_MIN_EYE_PX = 140;

export interface EyeTrait<T> {
  value: T;
  /** 0–1. Distance past the threshold, so borderline reads as low. */
  confidence: number;
}

export interface EyeShapeResult {
  tilt: EyeTrait<TiltTrait>;
  spacing: EyeTrait<SpacingTrait>;
  aperture: EyeTrait<ApertureTrait>;
  /** Null when no pixel reading was supplied. */
  lid: EyeTrait<LidTrait> | null;
  /** e.g. "Close-set · Monolid · Upturned". */
  summary: string;
  metrics: EyeMetrics;
  crease: CreaseReading | null;
}

/** Confidence from how far a value sits past a boundary, saturating at `span`. */
function certainty(value: number, boundary: number, span: number): number {
  return Math.max(0.15, Math.min(1, Math.abs(value - boundary) / span));
}

export function classifyEyes(
  metrics: EyeMetrics,
  crease: CreaseReading | null = null,
): EyeShapeResult {
  // ---- tilt ----
  let tilt: EyeTrait<TiltTrait>;
  if (metrics.tiltDeg >= TILT.upturned) {
    tilt = { value: "Upturned", confidence: certainty(metrics.tiltDeg, TILT.upturned, 5) };
  } else if (metrics.tiltDeg <= TILT.downturned) {
    tilt = { value: "Downturned", confidence: certainty(metrics.tiltDeg, TILT.downturned, 5) };
  } else {
    tilt = { value: "Neutral", confidence: 0.5 };
  }

  // ---- spacing ----
  let spacing: EyeTrait<SpacingTrait>;
  if (metrics.spacingRatio >= SPACING.wide) {
    spacing = { value: "Wide-set", confidence: certainty(metrics.spacingRatio, SPACING.wide, 0.12) };
  } else if (metrics.spacingRatio <= SPACING.close) {
    spacing = { value: "Close-set", confidence: certainty(metrics.spacingRatio, SPACING.close, 0.12) };
  } else {
    spacing = { value: "Average-set", confidence: 0.5 };
  }

  // ---- aperture ----
  let aperture: EyeTrait<ApertureTrait>;
  if (metrics.apertureRatio >= APERTURE.round) {
    aperture = { value: "Round", confidence: certainty(metrics.apertureRatio, APERTURE.round, 0.2) };
  } else if (metrics.apertureRatio <= APERTURE.narrow) {
    aperture = { value: "Narrow", confidence: certainty(metrics.apertureRatio, APERTURE.narrow, 0.2) };
  } else {
    aperture = { value: "Almond", confidence: 0.6 };
  }

  // ---- lid ----
  //
  // DISABLED BY DEFAULT — see LID_DETECTION_ENABLED. The crease reading is
  // computed and returned for inspection, but it is not turned into a label
  // because it has never been validated: on well-fitted faces it calls ~75%
  // of them "Hooded", the same collapse-to-one-answer pattern that plagued the
  // face-shape classifier. Publishing that would be inventing a detection.
  //   fold across most of the lid  -> Double eyelid
  //   fold over only part of it    -> Hooded   (the hood buries the rest)
  //   no fold anywhere             -> Monolid
  let lid: EyeTrait<LidTrait> | null = null;
  if (crease && LID_DETECTION_ENABLED && metrics.eyeWidthPx >= LID_MIN_EYE_PX) {
    if (crease.coverage < LID_COVERAGE_MIN) {
      // Little or no fold anywhere along the lid.
      lid = {
        value: "Monolid",
        confidence: certainty(crease.coverage, LID_COVERAGE_MIN, 0.2),
      };
    } else if (crease.height >= LID_HEIGHT_DOUBLE) {
      // Fold present and sitting high — an open lid platform beneath it.
      lid = {
        value: "Double eyelid",
        confidence: certainty(crease.height, LID_HEIGHT_DOUBLE, 0.25),
      };
    } else {
      // Fold present but pressed down near the lashes: the hood covers it.
      lid = {
        value: "Hooded",
        confidence: certainty(crease.height, LID_HEIGHT_DOUBLE, 0.3),
      };
    }
  }

  // Skip the "unremarkable" readings so the summary names only what stands out.
  const parts: string[] = [];
  if (spacing.value !== "Average-set") parts.push(spacing.value);
  if (lid) parts.push(lid.value);
  parts.push(aperture.value);
  if (tilt.value !== "Neutral") parts.push(tilt.value);

  return {
    tilt,
    spacing,
    aperture,
    lid,
    summary: parts.length ? parts.join(" · ") : "Balanced",
    metrics,
    crease,
  };
}
