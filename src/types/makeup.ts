/**
 * Type definitions for the "Makeup Map" data contract.
 *
 * These interfaces mirror the incoming JSON 1:1 so the parser, store, UI, and
 * canvas renderer all share one source of truth.
 */

/** The seven canonical face shapes scored during the calibration phase. */
export type FaceShape =
  | "Oval"
  | "Round"
  | "Square"
  | "Rectangle"
  | "Heart"
  | "Diamond"
  | "Triangle";

/** Primitive overlay shapes the Canvas renderer supports. */
export type OverlayType = "polyline" | "circle" | "ellipse";

/**
 * A single anchor: a MediaPipe landmark index plus an optional normalized
 * offset. The offset is expressed as a fraction of the face bounding box
 * (x → width, y → height) so placement stays scale-invariant across faces.
 */
export interface Anchor {
  /** MediaPipe Face Landmarker index (0–477). */
  landmark: number;
  offset?: { x: number; y: number };
}

/** Visual styling for an overlay. Pure data — no rendering logic. */
export interface OverlayStyle {
  stroke?: string;
  fill?: string;
  lineWidth?: number;
  opacity?: number;
  dashed?: boolean;
}

/** A connected line through an ordered list of anchors. */
export interface PolylineOverlay {
  overlayId: string;
  type: "polyline";
  style: OverlayStyle;
  anchors: Anchor[];
}

/**
 * A circle whose radius scales with the face: it is the pixel distance between
 * `center.landmark` and `radiusLandmark`. Filled when `style.fill` is set,
 * otherwise drawn as an outline (used dashed for e.g. the nose-tip blush).
 */
export interface CircleOverlay {
  overlayId: string;
  type: "circle";
  style: OverlayStyle;
  center: Anchor;
  radiusLandmark: number;
}

/**
 * A (typically dashed, outlined) ellipse that scales AND tilts with the face —
 * used for the blush ovals on the apples of the cheeks. The two semi-axes are
 * pixel distances from the center to two reference landmarks: `radiusLandmark`
 * sets the primary axis (and its direction sets the tilt), `ryLandmark` sets
 * the perpendicular axis.
 */
export interface EllipseOverlay {
  overlayId: string;
  type: "ellipse";
  style: OverlayStyle;
  center: Anchor;
  radiusLandmark: number;
  ryLandmark: number;
}

/** Discriminated union of all overlay kinds (switch on `type`). */
export type Overlay = PolylineOverlay | CircleOverlay | EllipseOverlay;

export interface ProductInfo {
  name: string;
  category: string;
  /** Any valid CSS color (hex or rgba) used for the UI swatch + overlay. */
  swatchColor: string;
}

export interface MakeupStep {
  stepId: string;
  order: number;
  name: string;
  product: ProductInfo;
  instruction: string;
  overlays: Overlay[];
  /**
   * Optional reference photo for the step (e.g. an example look). Rendered in
   * the panel when present; the image container is hidden when null/undefined.
   */
  imageUrl?: string | null;
}

export interface MakeupMapMetadata {
  title: string;
  difficulty?: string;
  estimatedMinutes?: number;
}

export interface MakeupMap {
  mapId: string;
  metadata: MakeupMapMetadata;
  steps: MakeupStep[];
}
