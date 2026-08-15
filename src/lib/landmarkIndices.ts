/**
 * A curated subset of MediaPipe Face Landmarker indices used for the MVP
 * placeholder overlay (proving tracking works). The full 478-point map will be
 * referenced by the JSON-driven renderer later.
 */

/** Approximate eye-region landmarks used to draw test dots over the eyes. */
export const LEFT_EYE_LANDMARKS = [33, 133, 159, 145, 160, 144] as const;
export const RIGHT_EYE_LANDMARKS = [362, 263, 386, 374, 387, 373] as const;

/** Iris centers (available with the 478-point model). */
export const LEFT_IRIS_CENTER = 468;
export const RIGHT_IRIS_CENTER = 473;

/** Face-extent landmarks, used to draw a debug bounding box. */
export const FACE_EXTENT_LANDMARKS = {
  top: 10, // forehead top
  bottom: 152, // chin
  left: 234, // right-side cheek edge (image space)
  right: 454, // left-side cheek edge (image space)
} as const;
