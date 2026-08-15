/**
 * Nose-shape analysis — two-stage: frontal, then profile.
 *
 * WHY TWO STAGES
 * --------------
 * Most named nose types are defined by the SIDE silhouette, not the front view.
 * Roman, Greek, Hawk, Snub and Celestial all differ only in whether the dorsal
 * line bulges outward, runs straight, or scoops inward — which is invisible
 * head-on. Only width, tip breadth and midline deviation read frontally.
 *
 * So the frontal pass narrows the field, and an optional profile pass resolves
 * the rest. With frontal alone the result is reported as partial rather than
 * guessed.
 *
 * A NOTE ON THE TAXONOMY
 * ----------------------
 * Several of the twelve names describe the same measurement at different
 * strengths rather than distinct geometry — Snub / Button / Turned-up all mean
 * "concave dorsum plus an upturned tip", and Hawk is a stronger Roman. They are
 * scored on a shared axis and separated by degree, which is honest about what
 * the measurement can actually resolve.
 *
 * Ethnicity is deliberately NOT an input. The descriptions that mention it are
 * pointing at geometry (a long bridge with a wide base, a low bridge with a
 * broad base) and that geometry is measured directly — inferring ancestry from
 * a face and feeding it back into the result would be both worse engineering
 * and not something this app should do.
 */

/** Minimal shape of a MediaPipe normalized landmark. */
interface NormalizedPoint {
  x: number;
  y: number;
  z?: number;
}

// ---------------------------------------------------------------------------
// Landmark indices (verified visually against real photos)
// ---------------------------------------------------------------------------

const N = {
  nasion: 168, // bridge top, between the eyes
  bridgeHigh: 6,
  bridgeMid: 197,
  bridgeLow: 195,
  supratip: 4,
  tip: 1,
  subnasale: 2, // columella base
  alarR: 129,
  alarL: 358,
  bridgeWidthR: 193,
  bridgeWidthL: 417,
  nostrilR: 98,
  nostrilL: 327,
  midAlarR: 115,
  midAlarL: 344,
  eyeR: 33,
  eyeL: 263,
  chin: 152,
  foreheadTop: 10,
} as const;

/** Bridge points between nasion and tip, in order — the dorsal line. */
const DORSUM = [N.nasion, N.bridgeHigh, N.bridgeMid, N.bridgeLow, N.supratip] as const;

// ---------------------------------------------------------------------------
// Head yaw — decides which measurements are trustworthy
// ---------------------------------------------------------------------------

/**
 * Rough head yaw, 0 = facing the camera, 1 = full profile.
 *
 * Uses how far the nose tip sits from the midpoint of the two outer eye
 * corners, scaled by their separation. Cheap and monotonic, which is all the
 * capture UI needs.
 */
export function estimateYaw(
  landmarks: NormalizedPoint[],
  width: number,
  height: number,
): number {
  if (!landmarks || landmarks.length < 468) return 0;
  const px = (i: number) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height });
  const a = px(N.eyeR);
  const b = px(N.eyeL);
  const nose = px(N.tip);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const span = Math.hypot(b.x - a.x, b.y - a.y) || 1e-6;
  return Math.min(1, (Math.abs(nose.x - mid.x) / span) * 2.2);
}

/** Below this the view counts as frontal; above it, as profile. */
export const YAW_FRONTAL_MAX = 0.25;
export const YAW_PROFILE_MIN = 0.55;

// ---------------------------------------------------------------------------
// Frontal measurements
// ---------------------------------------------------------------------------

export interface NoseFrontal {
  /** Alar (nostril) width ÷ inter-ocular distance. Breadth of the nose. */
  widthRatio: number;
  /** Alar width ÷ nose length. High = short and wide. */
  widthToLength: number;
  /** Upper bridge width ÷ alar width. High = broad, low bridge. */
  bridgeRatio: number;
  /** Mid-alar width ÷ alar width. High = the tip stays wide (bulbous). */
  tipRatio: number;
  /** Nostril span ÷ alar width. High = flared nostrils. */
  nostrilRatio: number;
  /** Sideways offset of the bridge from the face midline, ÷ alar width. */
  midlineOffset: number;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export function measureNoseFrontal(
  landmarks: NormalizedPoint[],
  width: number,
  height: number,
): NoseFrontal | null {
  if (!landmarks || landmarks.length < 468) return null;
  const px = (i: number) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height });

  const iod = dist(px(N.eyeR), px(N.eyeL)) || 1e-6;
  const alar = dist(px(N.alarR), px(N.alarL)) || 1e-6;
  const length = dist(px(N.nasion), px(N.subnasale)) || 1e-6;

  // Crooked: how far the bridge sits off the line joining forehead and chin.
  const top = px(N.foreheadTop);
  const chin = px(N.chin);
  const axis = { x: chin.x - top.x, y: chin.y - top.y };
  const axisLen = Math.hypot(axis.x, axis.y) || 1e-6;
  const u = { x: axis.x / axisLen, y: axis.y / axisLen };
  const perp = { x: -u.y, y: u.x };
  const offsetOf = (i: number) => {
    const d = { x: px(i).x - top.x, y: px(i).y - top.y };
    return d.x * perp.x + d.y * perp.y;
  };
  // Compare the bridge's offset with the face's own centre offset so a slightly
  // turned head doesn't read as a crooked nose.
  const faceCentre = (offsetOf(N.foreheadTop) + offsetOf(N.chin)) / 2;
  const bridgeOffset = (offsetOf(N.bridgeHigh) + offsetOf(N.bridgeMid)) / 2 - faceCentre;

  return {
    widthRatio: alar / iod,
    widthToLength: alar / length,
    bridgeRatio: dist(px(N.bridgeWidthR), px(N.bridgeWidthL)) / alar,
    tipRatio: dist(px(N.midAlarR), px(N.midAlarL)) / alar,
    nostrilRatio: dist(px(N.nostrilR), px(N.nostrilL)) / alar,
    midlineOffset: Math.abs(bridgeOffset) / alar,
  };
}

// ---------------------------------------------------------------------------
// Profile measurements — the discriminating ones
// ---------------------------------------------------------------------------

export interface NoseProfile {
  /**
   * THE key number. Signed deviation of the mid-bridge from the straight line
   * nasion→tip, as a fraction of nose length.
   *   > 0  bridge bulges forward  — Roman, and strongly so for Hawk
   *   ~ 0  straight               — Greek
   *   < 0  bridge scoops inward   — Snub, Button, Celestial
   */
  dorsalDeviation: number;
  /** Tip rotation: nasolabial angle in degrees. High = upturned. */
  tipRotation: number;
  /** Tip projection ÷ nose length. Low = flat, high = prominent. */
  projection: number;
  /** Nose length ÷ inter-ocular distance. */
  lengthRatio: number;
}

export function measureNoseProfile(
  landmarks: NormalizedPoint[],
  width: number,
  height: number,
): NoseProfile | null {
  if (!landmarks || landmarks.length < 468) return null;
  const px = (i: number) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height });

  const nasion = px(N.nasion);
  const tip = px(N.supratip);
  const sub = px(N.subnasale);
  const iod = dist(px(N.eyeR), px(N.eyeL)) || 1e-6;

  // Straight reference line nasion → tip.
  const axis = { x: tip.x - nasion.x, y: tip.y - nasion.y };
  const len = Math.hypot(axis.x, axis.y) || 1e-6;
  const u = { x: axis.x / len, y: axis.y / len };
  const perp = { x: -u.y, y: u.x };

  // Which side of that line is "outward"? The face centre is behind the nose,
  // so use the chin: outward is the direction pointing AWAY from it.
  const chin = px(N.chin);
  const chinSide =
    (chin.x - nasion.x) * perp.x + (chin.y - nasion.y) * perp.y;
  const outward = chinSide > 0 ? -1 : 1;

  // Signed deviation of each intermediate bridge point; take the extreme, so a
  // localised hump counts rather than being averaged away.
  let extreme = 0;
  for (const idx of DORSUM.slice(1, -1)) {
    const p = px(idx);
    const d = ((p.x - nasion.x) * perp.x + (p.y - nasion.y) * perp.y) * outward;
    if (Math.abs(d) > Math.abs(extreme)) extreme = d;
  }

  // Nasolabial angle: columella (subnasale → tip) against the facial vertical.
  const col = { x: tip.x - sub.x, y: tip.y - sub.y };
  const vert = { x: chin.x - px(N.foreheadTop).x, y: chin.y - px(N.foreheadTop).y };
  const vlen = Math.hypot(vert.x, vert.y) || 1e-6;
  const cosA =
    (col.x * vert.x + col.y * vert.y) / ((Math.hypot(col.x, col.y) || 1e-6) * vlen);
  const tipRotation = (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI;

  // Projection: how far the tip stands off the nasion→subnasale line.
  const base = { x: sub.x - nasion.x, y: sub.y - nasion.y };
  const blen = Math.hypot(base.x, base.y) || 1e-6;
  const bperp = { x: -base.y / blen, y: base.x / blen };
  const projection =
    Math.abs((tip.x - nasion.x) * bperp.x + (tip.y - nasion.y) * bperp.y) / blen;

  return {
    dorsalDeviation: extreme / len,
    tipRotation,
    projection,
    lengthRatio: blen / iod,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type NoseType =
  | "Roman"
  | "Hawk"
  | "Greek"
  | "Button"
  | "Snub"
  | "Turned-up"
  | "Nubian"
  | "Flat"
  | "Bulbous"
  | "Wide"
  | "Narrow"
  | "Crooked";

export interface NoseScore {
  type: NoseType;
  score: number;
  confidence: number;
}

export interface NoseShapeResult {
  type: NoseType;
  ranked: NoseScore[];
  /** True when a profile pass contributed — without it the result is partial. */
  hasProfile: boolean;
  /** Plain-language reason, e.g. "bridge curves outward, tip sits low". */
  reason: string;
  frontal: NoseFrontal;
  profile: NoseProfile | null;
}

/**
 * Population reference for the frontal ratios, measured by THIS code across
 * real faces. As with face shape, textbook figures sit on a different scale
 * than these landmarks produce, so boundaries are set from measurement.
 */
const F_MEAN = {
  widthRatio: 0.446, widthToLength: 0.85, bridgeRatio: 0.369,
  tipRatio: 0.741, nostrilRatio: 0.82, midlineOffset: 0.020,
};
const F_SD = {
  widthRatio: 0.037, widthToLength: 0.12, bridgeRatio: 0.037,
  tipRatio: 0.023, nostrilRatio: 0.07, midlineOffset: 0.015,
};

/** Profile boundaries, in the units `measureNoseProfile` returns. */
const P = {
  /** Dorsal deviation: beyond these the bridge reads as curved, not straight. */
  humpSlight: 0.035,
  humpStrong: 0.075,
  scoopSlight: -0.035,
  /** Nasolabial angle in degrees. */
  tipUpturned: 108,
  tipStrongUpturn: 118,
  /** Tip projection ÷ base length. */
  projectionLow: 0.34,
};

const z = (v: number, k: keyof typeof F_MEAN) => (v - F_MEAN[k]) / F_SD[k];

/**
 * Score every type, then rank.
 *
 * Profile-defined types are only scored when a profile reading exists — with
 * frontal alone they would be pure guesses, so they are left out entirely
 * rather than filled in.
 */
export function classifyNose(
  frontal: NoseFrontal,
  profile: NoseProfile | null = null,
): NoseShapeResult {
  const s: Partial<Record<NoseType, number>> = {};
  const why: string[] = [];

  // ---- frontal-only types ------------------------------------------------
  const wide = z(frontal.widthRatio, "widthRatio");
  const tipW = z(frontal.tipRatio, "tipRatio");
  const bridgeW = z(frontal.bridgeRatio, "bridgeRatio");
  const crooked = z(frontal.midlineOffset, "midlineOffset");

  s.Wide = sigmoid(wide - 0.9);
  s.Narrow = sigmoid(-wide - 0.9);
  s.Bulbous = sigmoid(tipW - 0.9);
  s.Crooked = sigmoid(crooked - 1.4);
  // Flat = broad AND a wide, low bridge. Confirmed by low projection if known.
  s.Flat = sigmoid(Math.min(wide, bridgeW) - 0.7);
  // Nubian = long bridge with a wide base.
  s.Nubian = sigmoid(wide - 0.6) * sigmoid(-z(frontal.widthToLength, "widthToLength") - 0.3);

  if (wide > 0.9) why.push("broad base");
  if (wide < -0.9) why.push("narrow base");
  if (tipW > 0.9) why.push("wide tip");
  if (crooked > 1.4) why.push("bridge off midline");

  // ---- profile-defined types --------------------------------------------
  if (profile) {
    const d = profile.dorsalDeviation;
    const rot = profile.tipRotation;

    // Convex family: Roman is a slight hump, Hawk a pronounced one.
    s.Roman = band(d, P.humpSlight, P.humpStrong) * 1.1;
    s.Hawk = sigmoid((d - P.humpStrong) / 0.03);
    // Straight dorsum, tip neither raised nor dropped.
    s.Greek = gauss(d, 0, 0.03) * gauss(rot, 100, 12) * 1.15;
    // Concave family, separated by how far the tip is rotated up.
    const scoop = sigmoid((P.scoopSlight - d) / 0.03);
    s["Turned-up"] = scoop * sigmoid((rot - P.tipUpturned) / 6);
    s.Snub = scoop * sigmoid((rot - P.tipStrongUpturn) / 6) * 1.05;
    s.Button = scoop * sigmoid((rot - P.tipUpturned) / 6) * sigmoid(-wide - 0.2);
    // Flat and Nubian gain or lose support from projection.
    s.Flat = (s.Flat ?? 0) * (1 + sigmoid((P.projectionLow - profile.projection) / 0.05));
    s.Nubian = (s.Nubian ?? 0) * (1 + sigmoid((profile.lengthRatio - 0.55) / 0.08));

    if (d > P.humpStrong) why.push("bridge curves out strongly");
    else if (d > P.humpSlight) why.push("slight bridge hump");
    else if (d < P.scoopSlight) why.push("bridge scoops in");
    else why.push("straight bridge");
    if (rot > P.tipStrongUpturn) why.push("tip strongly upturned");
    else if (rot > P.tipUpturned) why.push("tip upturned");
    if (profile.projection < P.projectionLow) why.push("low projection");
  }

  const raw = (Object.entries(s) as [NoseType, number][])
    .map(([type, score]) => ({ type, score: Math.max(0, score) }))
    .sort((a, b) => b.score - a.score);
  const total = raw.reduce((a, r) => a + r.score, 0) || 1;
  const ranked = raw.map((r) => ({ ...r, confidence: r.score / total }));

  return {
    type: ranked[0]?.type ?? "Wide",
    ranked,
    hasProfile: !!profile,
    reason: why.join(", ") || "no strong features",
    frontal,
    profile,
  };
}

// -- small helpers ----------------------------------------------------------

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const gauss = (x: number, mu: number, sd: number) => Math.exp(-(((x - mu) / sd) ** 2) / 2);
/** Peaks inside [lo, hi] and falls off outside it. */
function band(x: number, lo: number, hi: number): number {
  const mid = (lo + hi) / 2;
  return gauss(x, mid, Math.max((hi - lo) / 2, 1e-6));
}
