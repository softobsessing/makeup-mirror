import { create } from "zustand";
import type { FaceShape, MakeupMap, MakeupStep } from "../types/makeup";
import { adaptMakeupMap, type RawMakeupMap } from "../lib/adaptMakeupMap";
import type { FaceShapeScore } from "../lib/faceShape";
import type { EyeShapeResult } from "../lib/eyeShape";
import type { NoseShapeResult } from "../lib/noseShape";

/**
 * Lifecycle of the camera permission request.
 */
export type CameraPermission = "idle" | "pending" | "granted" | "denied";

/**
 * High-level app phase: scan the face first, then run the guided steps.
 */
export type AppState = "CALIBRATING" | "GUIDE";

/**
 * Stable id of the "get closer" transition step. This step draws NO overlays —
 * instead the UI (CameraMirror) shows a full-screen prompt asking the user to
 * move closer before the fine eye-area steps. Exported so components can detect
 * it without hard-coding the string.
 */
export const EYE_ZOOM_STEP_ID = "eye_zoom_prompt";

/**
 * Stable id of the final "reveal" step. Draws NO overlays and no zoom — the UI
 * (CameraMirror) shows a clean full-face mirror plus an "OKAY BADDIE" celebration
 * banner: the big reveal now that all the makeup is done.
 */
export const REVEAL_STEP_ID = "reveal";

/**
 * Guided K-beauty tutorial sequence.
 *
 * NOTE: `overlays` are intentionally empty placeholders for now — the on-face
 * landmark guides will be authored per step later. Each step carries a
 * `stepId`, display `name`, `instruction`, and an optional `imageUrl` reference
 * photo. `adaptMakeupMap` still enriches each step with product/swatch defaults.
 *
 * One entry (`eye_zoom_prompt`) is a UI transition rather than a drawing step:
 * it pauses the on-face guides and prompts the user to move closer to the
 * camera before the detailed eye work begins.
 */
const MAKEUP_TUTORIAL_MAP: RawMakeupMap = {
  mapId: "kbeauty-tutorial",
  steps: [
    {
      stepId: "face_contour",
      name: "Facial Bone Structure Contour",
      instruction:
        "Contour the hollows under your cheekbones, along your jaw, and at your temples to sculpt your bone structure.",
      imageUrl: null,
      overlays: [],
    },
    {
      stepId: "nose_contour",
      name: "Nose Contour",
      instruction:
        "Sweep contour down the sides of your nose bridge to slim and define it.",
      imageUrl: null,
      overlays: [],
    },
    {
      stepId: "blush",
      name: "Blush",
      instruction: "Sweep blush across the apples of your cheeks for a healthy flush.",
      imageUrl: null,
      overlays: [],
    },
    {
      // UI transition — no overlays. CameraMirror shows the "get closer" prompt.
      stepId: EYE_ZOOM_STEP_ID,
      name: "Get Closer",
      instruction: "Please get closer to the camera for the eye area details.",
      imageUrl: null,
      overlays: [],
    },
    {
      stepId: "eyeshadow_1",
      name: "Eyeshadow · Base",
      instruction:
        "Sweep your base shade up to the dotted arc — from the inner corner to the outer corner across the lid.",
      imageUrl: null,
      overlays: [],
    },
    {
      stepId: "eyeshadow_2",
      name: "Eyeshadow · Deepen",
      instruction:
        "With a darker shade, follow the two lower humps to deepen the inner and outer corners, keeping the center lighter.",
      imageUrl: null,
      overlays: [],
    },
    {
      stepId: "tightlining",
      name: "Tightlining",
      instruction: "Line your upper waterline to make your lashes look fuller.",
      imageUrl: null,
      overlays: [],
    },
    {
      stepId: "eyeliner",
      name: "Eyeliner",
      instruction: "Trace your upper lash line and extend a soft wing.",
      imageUrl: null,
      overlays: [],
    },
    {
      // No overlay — a prompt-only step so the user knows to apply false lashes.
      stepId: "false_lashes",
      name: "False Lashes",
      instruction: "Pop on a pair of false lashes for extra flutter 👁️",
      imageUrl: null,
      overlays: [],
    },
    {
      stepId: "aegyo_sal",
      name: "Aegyo Sal",
      instruction: "Add a soft shimmer just under your eyes to create a cute aegyo-sal.",
      imageUrl: null,
      overlays: [],
    },
    {
      // Final reveal — no overlays, no zoom. CameraMirror shows a clean mirror
      // with the "OKAY BADDIE" celebration banner.
      stepId: REVEAL_STEP_ID,
      name: "The Reveal",
      instruction: "You're all done — okay baddie! 💖",
      imageUrl: null,
      overlays: [],
    },
  ],
};

/** The active map: compact placement enriched with styling + product info. */
const ACTIVE_MAKEUP_MAP: MakeupMap = adaptMakeupMap(MAKEUP_TUTORIAL_MAP);

interface MakeupState {
  // ---- Camera / tracking status (discrete UI state only) ----
  /**
   * IMPORTANT: per-frame landmark data is intentionally NOT stored here.
   * Landmarks update 30–60×/sec and live in refs inside the render loop to
   * avoid React re-render storms. Only coarse, change-on-transition flags
   * (like `faceDetected`) are mirrored into the store.
   */
  cameraPermission: CameraPermission;
  cameraError: string | null;
  trackingActive: boolean;
  faceDetected: boolean;

  // ---- Calibration state ----
  appState: AppState;
  detectedFaceShape: FaceShape | null;
  /**
   * All seven shapes scored and ranked (best first) from the calibration scan.
   * The UI shows the top match prominently and the runner-up subtly, so how
   * close the call was stays visible instead of being hidden behind one label.
   */
  faceShapeRanking: FaceShapeScore[] | null;
  /** How many pose-accepted frames were averaged for the reading. */
  faceShapeSamples: number;
  /** Set when the top two are near-tied, e.g. "Oval–Diamond". */
  faceShapeBlend: string | null;
  /** Coarse length reading: the part of the measurement that holds up. */
  faceShapeLengthClass: "compact" | "elongated" | null;
  /** Multi-label eye reading (tilt / spacing / aperture) from the eye scan. */
  eyeShape: EyeShapeResult | null;
  /**
   * Nose reading. Most nose types are defined by the SIDE silhouette, so this
   * is captured in two passes; `hasProfile` says whether the profile pass
   * happened, and the result is partial until it has.
   */
  noseShape: NoseShapeResult | null;
  /** True while the UI is asking the user to turn for the profile capture. */
  awaitingNoseProfile: boolean;
  /**
   * Faux per-feature "detection" flags. These do NOT run any real classifier —
   * they gate the illusion that the mirror scanned the nose / eyes and recognized
   * a (hard-coded) type once the user reaches those steps. See App's feature
   * badges and CameraMirror's scan-sweep effect.
   *
   * NOTE: the face SHAPE is really classified at calibration, but we defer
   * REVEALING it until the facial-contour step (faceShapeScanned) so it plays as
   * an in-context scan there rather than at the very beginning.
   */
  faceShapeScanned: boolean;
  noseScanned: boolean;
  eyesScanned: boolean;

  // ---- Session / step state ----
  makeupMap: MakeupMap;
  currentStepIndex: number;

  // ---- Camera actions ----
  setCameraPermission: (permission: CameraPermission) => void;
  setCameraError: (error: string | null) => void;
  setTrackingActive: (active: boolean) => void;
  setFaceDetected: (detected: boolean) => void;

  // ---- Calibration actions ----
  /** Save the classified shape (+ optional full ranking) and enter the steps. */
  setFaceShape: (
    shape: FaceShape,
    ranking?: FaceShapeScore[],
    samples?: number,
    blend?: string | null,
    shortlist?: { lengthClass: "compact" | "elongated" },
  ) => void;
  /** Return to the scan screen to re-detect the face shape. */
  recalibrate: () => void;
  /** Mark the (faux) face-shape / nose / eye scans complete so badges reveal. */
  markFaceShapeScanned: () => void;
  markNoseScanned: () => void;
  markEyesScanned: () => void;
  /** Store the measured eye traits (called when the eye scan completes). */
  setEyeShape: (result: EyeShapeResult) => void;
  /** Clear the eye reading so the eye scan replays on this step. */
  rescanEyes: () => void;
  setNoseShape: (result: NoseShapeResult) => void;
  setAwaitingNoseProfile: (waiting: boolean) => void;
  /** Clear the nose reading so its scan replays on this step. */
  rescanNose: () => void;

  // ---- Step actions ----
  nextStep: () => void;
  prevStep: () => void;
  goToStep: (index: number) => void;
}

export const useMakeupStore = create<MakeupState>((set) => ({
  cameraPermission: "idle",
  cameraError: null,
  trackingActive: false,
  faceDetected: false,

  appState: "CALIBRATING",
  detectedFaceShape: null,
  faceShapeRanking: null,
  faceShapeSamples: 0,
  faceShapeBlend: null,
  faceShapeLengthClass: null,
  eyeShape: null,
  noseShape: null,
  awaitingNoseProfile: false,
  faceShapeScanned: false,
  noseScanned: false,
  eyesScanned: false,

  makeupMap: ACTIVE_MAKEUP_MAP,
  currentStepIndex: 0,

  setCameraPermission: (permission) => set({ cameraPermission: permission }),
  setCameraError: (error) => set({ cameraError: error }),
  setTrackingActive: (active) => set({ trackingActive: active }),

  // Guard against redundant writes so the per-frame loop can call freely
  // without triggering re-renders when the value hasn't changed.
  setFaceDetected: (detected) =>
    set((state) => (state.faceDetected === detected ? state : { faceDetected: detected })),

  setFaceShape: (shape, ranking, samples, blend, shortlist) =>
    set({
      detectedFaceShape: shape,
      faceShapeRanking: ranking ?? null,
      faceShapeSamples: samples ?? 0,
      faceShapeBlend: blend ?? null,
      faceShapeLengthClass: shortlist?.lengthClass ?? null,
          appState: "GUIDE",
      currentStepIndex: 0,
      faceShapeScanned: false,
      noseScanned: false,
      eyesScanned: false,
    }),

  recalibrate: () =>
    set({
      appState: "CALIBRATING",
      detectedFaceShape: null,
      faceShapeRanking: null,
      faceShapeSamples: 0,
      faceShapeBlend: null,
      faceShapeLengthClass: null,
      eyeShape: null,
  noseShape: null,
  awaitingNoseProfile: false,
      faceShapeScanned: false,
      noseScanned: false,
      eyesScanned: false,
    }),

  markFaceShapeScanned: () =>
    set((s) => (s.faceShapeScanned ? s : { faceShapeScanned: true })),
  markNoseScanned: () => set((s) => (s.noseScanned ? s : { noseScanned: true })),
  markEyesScanned: () => set((s) => (s.eyesScanned ? s : { eyesScanned: true })),

  setEyeShape: (result) => set({ eyeShape: result }),

  rescanEyes: () => set({ eyeShape: null, eyesScanned: false }),

  setNoseShape: (result) => set({ noseShape: result, awaitingNoseProfile: false }),
  setAwaitingNoseProfile: (waiting) => set({ awaitingNoseProfile: waiting }),
  rescanNose: () =>
    set({ noseShape: null, noseScanned: false, awaitingNoseProfile: false }),

  nextStep: () =>
    set((state) => {
      const total = state.makeupMap.steps.length;
      const next = Math.min(state.currentStepIndex + 1, total - 1);
      return next === state.currentStepIndex ? state : { currentStepIndex: next };
    }),

  prevStep: () =>
    set((state) => {
      const prev = Math.max(state.currentStepIndex - 1, 0);
      return prev === state.currentStepIndex ? state : { currentStepIndex: prev };
    }),

  goToStep: (index) =>
    set((state) => {
      const total = state.makeupMap.steps.length;
      const clamped = Math.max(0, Math.min(index, total - 1));
      return clamped === state.currentStepIndex ? state : { currentStepIndex: clamped };
    }),
}));

/** Selector: the currently active step. */
export const selectCurrentStep = (state: MakeupState): MakeupStep =>
  state.makeupMap.steps[state.currentStepIndex];

/** Selector: the current step's id (safe if the index is ever out of range). */
export const selectCurrentStepId = (state: MakeupState): string | undefined =>
  state.makeupMap.steps[state.currentStepIndex]?.stepId;
