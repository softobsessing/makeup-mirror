import { useEffect, useRef, useState } from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { createFaceLandmarker } from "../lib/faceLandmarker";
import { classifyFaceShape, createFaceShapeSampler } from "../lib/faceShape";
import {
  measureEyes,
  classifyEyes,
  analyseCrease,
  type EyeMetrics,
} from "../lib/eyeShape";
import {
  measureNoseFrontal,
  measureNoseProfile,
  classifyNose,
  estimateYaw,
  YAW_PROFILE_MIN,
  type NoseFrontal,
} from "../lib/noseShape";
import { captureScan, installCalibrationConsole } from "../lib/faceShapeCalibration";
import { createMakeupRenderer, type MakeupRenderer } from "../lib/makeupGL";
import {
  EYE_ZOOM_STEP_ID,
  REVEAL_STEP_ID,
  selectCurrentStepId,
  useMakeupStore,
} from "../store/useMakeupStore";
import ScannerOverlay from "./ScannerOverlay";

/** Steps where we digitally zoom into the eye area for a clearer close-up. */
const EYE_STEPS = new Set<string>([
  EYE_ZOOM_STEP_ID,
  "eyeshadow_1",
  "eyeshadow_2",
  "tightlining",
  "eyeliner",
  "false_lashes",
  "aegyo_sal",
]);

/**
 * Step ids that have an authored makeup atlas (served from /public/atlases).
 * Paths go through BASE_URL so the app also works when hosted under a
 * sub-path, as GitHub Pages does at /<repo>/.
 */
const B = import.meta.env.BASE_URL;
const STEP_ATLASES: Record<string, string> = {
  nose_contour: `${B}atlases/atlas_nose_contour.png`,
  face_contour: `${B}atlases/atlas_face_contour.png`,
  blush: `${B}atlases/atlas_blush.png`,
  eyeshadow_1: `${B}atlases/atlas_eyeshadow_1.png`,
  eyeshadow_2: `${B}atlases/atlas_eyeshadow_2.png`,
  tightlining: `${B}atlases/atlas_tightlining.png`,
  eyeliner: `${B}atlases/atlas_eyeliner.png`,
  aegyo_sal: `${B}atlases/atlas_aegyo_sal.png`,
};

/** Minimal landmark shape (MediaPipe normalized point). */
type Pt = { x: number; y: number; z?: number };

/**
 * Best-effort human-readable description of ANY thrown value. MediaPipe's WASM
 * runtime and the browser camera APIs throw a mix of Error, DOMException,
 * strings, numbers, and plain objects, so we normalize them all here.
 */
function describeError(err: unknown): string {
  if (err instanceof DOMException) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Draws a glowing, dashed face-shaped silhouette to guide the user where to
 * position their face during calibration. Turns green when a face is present.
 */
function drawFaceGuide(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  ready: boolean,
) {
  const cx = w / 2;
  const cy = h * 0.46;
  const rx = w * 0.17;
  const ry = h * 0.3;

  ctx.save();
  ctx.shadowBlur = 28;
  ctx.shadowColor = ready ? "rgba(80, 230, 160, 0.9)" : "rgba(95, 209, 249, 0.85)";
  ctx.strokeStyle = ready ? "rgba(80, 230, 160, 0.95)" : "rgba(190, 238, 255, 0.9)";
  ctx.lineWidth = 3;
  ctx.setLineDash([12, 9]);
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** A short, soft "scan complete" chime via the Web Audio API (no asset). */
function playScanSound() {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(990, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
    osc.onended = () => ctx.close();
  } catch {
    /* audio is best-effort */
  }
}

/**
 * CameraMirror
 *
 * Owns the live webcam + MediaPipe tracking loop. It:
 *  - streams the webcam into a <video> and tracks 478 landmarks,
 *  - mirrors video + canvas via one CSS flip on their shared parent,
 *  - renders EITHER the calibration silhouette (CALIBRATING) or the active
 *    step's JSON overlays (GUIDE), read from the store via getState().
 *
 * Performance contract: per-frame landmark data never enters React state — it
 * lives in refs and is consumed directly by the draw call. Only the coarse
 * `faceDetected` flag is mirrored into the store, and only on transitions.
 */
export default function CameraMirror() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const makeupCanvasRef = useRef<HTMLCanvasElement>(null);

  // Mutable, non-reactive refs for the tracking loop.
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const makeupRendererRef = useRef<MakeupRenderer | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);
  const latestLandmarksRef = useRef<Pt[] | null>(null);
  // Accumulates pose-accepted frames while calibrating so the shape reading is
  // an average of ~30 frontal frames rather than one arbitrary instant.
  const shapeSamplerRef = useRef(createFaceShapeSampler());
  // Rolling buffer of eye measurements. Cheap per frame (a handful of
  // distances), and taking the median at scan time keeps one blink or glance
  // from deciding the reading.
  const eyeBufRef = useRef<EyeMetrics[]>([]);
  // Frontal nose reading, held while we ask the user to turn for the profile.
  const noseFrontalRef = useRef<NoseFrontal | null>(null);
  // Live head yaw, so the profile prompt can show a turn meter without
  // re-rendering every frame.
  const yawRef = useRef(0);

  const [flashing, setFlashing] = useState(false);

  const setCameraPermission = useMakeupStore((s) => s.setCameraPermission);
  const setCameraError = useMakeupStore((s) => s.setCameraError);
  const setTrackingActive = useMakeupStore((s) => s.setTrackingActive);
  const setFaceDetected = useMakeupStore((s) => s.setFaceDetected);
  const setFaceShape = useMakeupStore((s) => s.setFaceShape);
  const nextStep = useMakeupStore((s) => s.nextStep);
  const faceShapeScanned = useMakeupStore((s) => s.faceShapeScanned);
  const faceShapeSamples = useMakeupStore((s) => s.faceShapeSamples);
  const faceShapeRanking = useMakeupStore((s) => s.faceShapeRanking);
  /** Best-scoring shape — the detected result. */
  const topGuess = faceShapeRanking?.[0];
  const faceShapeLengthClass = useMakeupStore((s) => s.faceShapeLengthClass);
  const noseScanned = useMakeupStore((s) => s.noseScanned);
  const eyesScanned = useMakeupStore((s) => s.eyesScanned);
  const markFaceShapeScanned = useMakeupStore((s) => s.markFaceShapeScanned);
  const markNoseScanned = useMakeupStore((s) => s.markNoseScanned);
  const markEyesScanned = useMakeupStore((s) => s.markEyesScanned);
  const setEyeShape = useMakeupStore((s) => s.setEyeShape);
  const setNoseShape = useMakeupStore((s) => s.setNoseShape);
  const setAwaitingNoseProfile = useMakeupStore((s) => s.setAwaitingNoseProfile);
  const awaitingNoseProfile = useMakeupStore((s) => s.awaitingNoseProfile);
  const [yawPct, setYawPct] = useState(0);
  const [featureScanLabel, setFeatureScanLabel] = useState<string | null>(null);
  // Mirrored into a ref so the per-frame render loop (which reads refs, not
  // React state) can hold the makeup back until the scan sweep finishes.
  const featureScanningRef = useRef(false);
  // After the face scan, ask the user to confirm from a measured shortlist.
  const [shapeReveal, setShapeReveal] = useState(false);

  // Reactive reads for the React-rendered overlays only.
  const appState = useMakeupStore((s) => s.appState);
  const faceDetected = useMakeupStore((s) => s.faceDetected);
  const currentStepId = useMakeupStore(selectCurrentStepId);
  const currentStepIndex = useMakeupStore((s) => s.currentStepIndex);
  const prevStep = useMakeupStore((s) => s.prevStep);
  const isEyeZoomStep = appState === "GUIDE" && currentStepId === EYE_ZOOM_STEP_ID;
  const isRevealStep = appState === "GUIDE" && currentStepId === REVEAL_STEP_ID;
  // Digitally zoom into the eye area (center of frame) for the eye-detail steps.
  const zoomEyes = appState === "GUIDE" && !!currentStepId && EYE_STEPS.has(currentStepId);

  // The eye transition is an automatic interstitial, not a manual step: entering
  // it going FORWARD shows "Now for the eyes" briefly (while the zoom glides in),
  // then advances on its own; entering it going BACKWARD just skips past it — so
  // there's no button and no getting stuck bouncing between steps.
  const prevStepIdxRef = useRef(currentStepIndex);
  useEffect(() => {
    const prev = prevStepIdxRef.current;
    prevStepIdxRef.current = currentStepIndex;
    if (appState !== "GUIDE" || currentStepId !== EYE_ZOOM_STEP_ID) return;
    if (prev > currentStepIndex) {
      prevStep(); // navigating backward → skip the interstitial
      return;
    }
    const t = window.setTimeout(nextStep, 1900);
    return () => window.clearTimeout(t);
  }, [currentStepId, currentStepIndex, appState, nextStep, prevStep]);

  // Faux feature detection: the first time the user lands on the nose step (and,
  // once zoomed in, the first eye step), play a scan-sweep + chime, then reveal
  // the hard-coded "nose type" / "eye type" badge — the illusion of recognition.
  useEffect(() => {
    if (appState !== "GUIDE") return;
    let kind: "face" | "nose" | "eyes" | null = null;
    if (currentStepId === "nose_contour" && !noseScanned) kind = "nose";
    else if (currentStepId === "face_contour" && !faceShapeScanned) kind = "face";
    else if (currentStepId === "eyeshadow_1" && !eyesScanned) kind = "eyes";
    if (!kind) return;

    const labels = {
      face: "Scanning your bone structure… 🔍",
      nose: "Scanning your nose… 🔍",
      eyes: "Scanning your eyes… 🔍",
    };
    // Hold the makeup back while the green line sweeps, then drop it on.
    featureScanningRef.current = true;
    setFeatureScanLabel(labels[kind]);
    playScanSound();
    const t = window.setTimeout(() => {
      if (kind === "face") markFaceShapeScanned();
      else if (kind === "nose") {
        // Frontal pass gives width / tip / crookedness. The types that depend
        // on the dorsal line need a profile, so ask for the turn next.
        const lm = latestLandmarksRef.current;
        const canvas = canvasRef.current;
        if (lm && canvas) {
          const f = measureNoseFrontal(lm, canvas.width, canvas.height);
          if (f) {
            noseFrontalRef.current = f;
            setNoseShape(classifyNose(f, null));
            setAwaitingNoseProfile(true);
          }
        }
        markNoseScanned();
      }
      else {
        // Classify the eyes from the median of the buffered frames.
        const buf = eyeBufRef.current;
        if (buf.length) {
          const med = (pick: (m: EyeMetrics) => number) => {
            const v = buf.map(pick).sort((a, b) => a - b);
            const mid = v.length >> 1;
            return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
          };
          // Grab one frame's pixels for the lid-fold read. Done once here
          // rather than per frame — reading back from the GPU is expensive.
          let crease = null;
          const video = videoRef.current;
          const lm = latestLandmarksRef.current;
          if (video && lm && video.videoWidth) {
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const off = document.createElement("canvas");
            off.width = vw;
            off.height = vh;
            const octx = off.getContext("2d", { willReadFrequently: true });
            if (octx) {
              octx.drawImage(video, 0, 0, vw, vh);
              const { data } = octx.getImageData(0, 0, vw, vh);
              const sample = (x: number, y: number) => {
                if (x < 0 || y < 0 || x >= vw || y >= vh) return 0;
                const i = (y * vw + x) * 4;
                // Rec. 601 luma — the fold is a shading edge, not a colour one.
                return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
              };
              const both = (["right", "left"] as const)
                .map((s) => analyseCrease(lm, vw, vh, sample, s))
                .filter((c): c is NonNullable<typeof c> => !!c);
              if (both.length) {
                crease = {
                  coverage: both.reduce((a, b) => a + b.coverage, 0) / both.length,
                  strength: both.reduce((a, b) => a + b.strength, 0) / both.length,
                  height: both.reduce((a, b) => a + b.height, 0) / both.length,
                };
              }
            }
          }

          const result = classifyEyes(
            {
              tiltDeg: med((m) => m.tiltDeg),
              spacingRatio: med((m) => m.spacingRatio),
              apertureRatio: med((m) => m.apertureRatio),
              eyeWidthPx: med((m) => m.eyeWidthPx),
              irisPx: med((m) => m.irisPx),
              hasIris: buf[0].hasIris,
            },
            crease,
          );
          console.info(`[Eyes] ${result.summary}`, result.metrics);
          setEyeShape(result);
        }
        markEyesScanned();
      }
      featureScanningRef.current = false;
      setFeatureScanLabel(null);
      // Flash the big shape card center-screen. Its dismissal lives in its own
      // effect below — marking the scan done re-runs THIS effect, so a timer
      // started here would be cleared by the cleanup before it could fire.
      if (kind === "face") setShapeReveal(true);
    }, 1350);
    return () => {
      window.clearTimeout(t);
      featureScanningRef.current = false;
    };
  }, [
    currentStepId,
    appState,
    faceShapeScanned,
    noseScanned,
    eyesScanned,
    markFaceShapeScanned,
    markNoseScanned,
    markEyesScanned,
    setEyeShape,
  ]);

  // Expose the calibration helpers on window for labeling sessions.
  useEffect(() => installCalibrationConsole(), []);

  /**
   * Profile capture for the nose.
   *
   * Polls the live yaw (a ref, so the tracking loop stays out of React) and
   * fires once the head is turned far enough. Most nose types — Roman, Greek,
   * Hawk, Snub — are only distinguishable from the side.
   */
  useEffect(() => {
    if (!awaitingNoseProfile) return;
    const id = window.setInterval(() => {
      const pct = Math.min(1, yawRef.current / YAW_PROFILE_MIN);
      setYawPct(pct);
      if (yawRef.current < YAW_PROFILE_MIN) return;

      const lm = latestLandmarksRef.current;
      const canvas = canvasRef.current;
      const frontal = noseFrontalRef.current;
      if (!lm || !canvas || !frontal) return;

      const prof = measureNoseProfile(lm, canvas.width, canvas.height);
      if (!prof) return;
      const result = classifyNose(frontal, prof);
      console.info(`[Nose] ${result.type} — ${result.reason}`, {
        frontal: result.frontal,
        profile: result.profile,
      });
      playScanSound();
      setNoseShape(result);
    }, 120);
    return () => window.clearInterval(id);
  }, [awaitingNoseProfile, setNoseShape]);

  // The result card is read-only, so it has to clear itself. Its own effect —
  // marking the scan done re-runs the scan effect, and a timer started there
  // would be cleared by that cleanup before it could fire.
  useEffect(() => {
    if (!shapeReveal) return;
    const t = window.setTimeout(() => setShapeReveal(false), 2200);
    return () => window.clearTimeout(t);
  }, [shapeReveal]);

  useEffect(() => {
    let cancelled = false;

    // Spin up the WebGL makeup renderer once (mesh + atlas textures load async).
    if (makeupCanvasRef.current && !makeupRendererRef.current) {
      try {
        makeupRendererRef.current = createMakeupRenderer(
          makeupCanvasRef.current,
          STEP_ATLASES,
        );
      } catch (e) {
        console.error("[CameraMirror] WebGL makeup init failed:", e);
      }
    }
    // Ordered step ids drive the cumulative per-step atlas compositing.
    const stepIds = useMakeupStore.getState().makeupMap.steps.map((s) => s.stepId);

    async function init() {
      // ---- Stage 1: load the MediaPipe face model (network/CDN dependent) ----
      let landmarker: FaceLandmarker;
      try {
        landmarker = await createFaceLandmarker();
      } catch (err) {
        if (cancelled) return;
        console.error("[CameraMirror] FaceLandmarker load failed:", err);
        setCameraPermission("idle");
        setCameraError(
          `Face model failed to load (network/CDN issue): ${describeError(err)}`,
        );
        setTrackingActive(false);
        return;
      }
      if (cancelled) {
        landmarker.close();
        return;
      }
      faceLandmarkerRef.current = landmarker;

      // ---- Stage 2: acquire the webcam ----
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "Camera API unavailable — open the app at http://localhost:5173 (a LAN IP over http is not a secure context).",
          );
        }

        setCameraPermission("pending");

        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cams = devices.filter((d) => d.kind === "videoinput");
          console.info(`[CameraMirror] videoinput devices: ${cams.length}`, cams);
        } catch (e) {
          console.warn("[CameraMirror] enumerateDevices failed:", e);
        }

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
        } catch (constraintErr) {
          if (
            constraintErr instanceof DOMException &&
            constraintErr.name === "OverconstrainedError"
          ) {
            console.warn("[CameraMirror] constraints too strict, retrying with defaults");
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          } else {
            throw constraintErr;
          }
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        setCameraPermission("granted");
        setCameraError(null);

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        setTrackingActive(true);
        rafRef.current = requestAnimationFrame(predict);
      } catch (err) {
        if (cancelled) return;
        console.error("[CameraMirror] camera acquisition failed:", err);

        let message = describeError(err);
        let denied = false;

        if (err instanceof DOMException) {
          switch (err.name) {
            case "NotAllowedError":
            case "SecurityError":
              denied = true;
              message = "Camera permission was blocked (browser or macOS).";
              break;
            case "NotFoundError":
            case "DevicesNotFoundError":
              message =
                "No camera available to this browser. If you're viewing inside an IDE/preview pane, open http://localhost:5173 in Chrome or Safari instead.";
              break;
            case "OverconstrainedError":
              message = "Camera can't satisfy the requested settings.";
              break;
            case "NotReadableError":
              message = "Camera is already in use by another app or tab. Close it and reload.";
              break;
            default:
              message = `${err.name}: ${err.message}`;
          }
        }

        setCameraPermission(denied ? "denied" : "idle");
        setCameraError(message);
        setTrackingActive(false);
      }
    }

    function predict() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const landmarker = faceLandmarkerRef.current;

      if (!video || !canvas || !landmarker || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(predict);
        return;
      }

      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      // Only run detection when a fresh video frame is available.
      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;
        const result = landmarker.detectForVideo(video, performance.now());
        render(canvas, result.faceLandmarks?.[0]);
      }

      rafRef.current = requestAnimationFrame(predict);
    }

    /** Per-frame draw: silhouette while calibrating, JSON overlays while guiding. */
    function render(canvas: HTMLCanvasElement, landmarks: Pt[] | undefined) {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const present = !!(landmarks && landmarks.length);
      setFaceDetected(present);
      latestLandmarksRef.current = present ? landmarks! : null;

      const state = useMakeupStore.getState();
      const renderer = makeupRendererRef.current;
      if (state.appState === "CALIBRATING") {
        // Collect frontal frames for the averaged shape reading. Frames where
        // the head is turned/tilted are rejected inside the sampler.
        if (present) shapeSamplerRef.current.addFrame(landmarks!, w, h);
        drawFaceGuide(ctx, w, h, present);
        renderer?.clear(w, h);
      } else if (present) {
        yawRef.current = estimateYaw(landmarks!, w, h);
        const em = measureEyes(landmarks!, w, h);
        if (em && Number.isFinite(em.tiltDeg)) {
          eyeBufRef.current.push(em);
          if (eyeBufRef.current.length > 45) eyeBufRef.current.shift();
        }
        const step = state.makeupMap.steps[state.currentStepIndex];
        // Pause makeup during the "get closer" transition, the false-lashes
        // prompt (nothing is drawn there), and the final reveal; the React
        // overlays own the screen there (reveal = clean mirror).
        if (
          step &&
          step.stepId !== EYE_ZOOM_STEP_ID &&
          step.stepId !== REVEAL_STEP_ID &&
          step.stepId !== "false_lashes" &&
          // Wait for the green scan sweep to finish before laying the guide on.
          !featureScanningRef.current
        ) {
          renderer?.render(landmarks!, w, h, state.currentStepIndex, stepIds);
        } else {
          renderer?.clear(w, h);
        }
      } else {
        renderer?.clear(w, h);
      }
    }

    init();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      faceLandmarkerRef.current?.close();
      faceLandmarkerRef.current = null;
      makeupRendererRef.current?.dispose();
      makeupRendererRef.current = null;
      setTrackingActive(false);
      setFaceDetected(false);
    };
    // Store setters from Zustand are stable; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Capture one frame of landmarks, classify the face, and enter GUIDE. */
  function handleScan() {
    const canvas = canvasRef.current;
    const lm = latestLandmarksRef.current;
    if (!canvas || !lm) return;

    // Prefer the pose-gated average of many frames; fall back to this single
    // frame only if no frontal frames were collected (e.g. instant tap).
    const result =
      shapeSamplerRef.current.classify() ??
      classifyFaceShape(lm, canvas.width, canvas.height);

    console.info(
      `[Calibration] elongation ${result.ratios.elongation.toFixed(3)} ` +
        `-> ${result.lengthClass} (split at 1.308) over ${result.samples} frame(s). ` +
        `Offering: ${result.candidates.join(", ")}`,
      { ratios: result.ratios },
    );

    playScanSound();
    setFlashing(true);
    window.setTimeout(() => setFlashing(false), 450);

    // Record the feature vector so the prototypes can be fitted to labeled
    // faces later (see faceShapeCalibration — console-driven, no UI).
    captureScan(result.ratios, result.ranked, result.samples);

    setFaceShape(result.shape, result.ranked, result.samples, result.blendLabel, {
      lengthClass: result.lengthClass,
    });
    shapeSamplerRef.current.reset();
  }

  return (
    <>
      {/* Shared parent is flipped once → video + canvas mirror together. On the
          eye steps we additionally scale it to zoom into the eye area; video and
          makeup canvas scale as one, so they stay aligned. */}
      <div
        className="absolute inset-0 overflow-hidden transition-transform duration-700 ease-out"
        style={{
          transform: zoomEyes ? "scaleX(-1) scale(2.7)" : "scaleX(-1)",
          transformOrigin: "center 40%",
        }}
      >
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          playsInline
          muted
          autoPlay
        />
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-cover" />
        {/* WebGL soft-makeup layer (transparent; DOM composites it over video). */}
        <canvas
          ref={makeupCanvasRef}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>

      {appState === "CALIBRATING" && (
        <ScannerOverlay onScan={handleScan} faceDetected={faceDetected} />
      )}

      {/* Eye transition: an automatic "Now for the eyes" interstitial (no button;
          it auto-advances while the camera zooms into the eye area). */}
      {isEyeZoomStep && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-6">
          <div className="panel-candy animate-pop w-full max-w-sm rounded-[2rem] p-8 text-center">
            <div className="animate-bob mb-2 text-5xl">👁️</div>
            <h2 className="text-candy-gradient font-display text-3xl font-bold">
              Now for the eyes ✨
            </h2>
            <p className="mt-2 font-body font-semibold text-plum/85">
              Zooming in for the detailed eye steps…
            </p>
          </div>
        </div>
      )}

      {/* Final reveal: a clean full-face mirror (no guides, no zoom) with a big
          "OKAY BADDIE" celebration banner + a sparkle burst — the glow-up reveal. */}
      {isRevealStep && (
        <div className="absolute inset-0 z-30 overflow-hidden">
          {/* sparkle burst */}
          {[
            { e: "✨", c: "left-[10%] top-[16%] text-5xl", d: "0ms" },
            { e: "💖", c: "right-[12%] top-[22%] text-4xl", d: "160ms" },
            { e: "✨", c: "left-[16%] top-[52%] text-3xl", d: "320ms" },
            { e: "⭐", c: "right-[9%] top-[46%] text-4xl", d: "90ms" },
            { e: "✨", c: "right-[20%] bottom-[24%] text-5xl", d: "240ms" },
            { e: "💫", c: "left-[12%] bottom-[20%] text-4xl", d: "400ms" },
            { e: "✨", c: "left-[46%] top-[10%] text-3xl", d: "520ms" },
            { e: "💖", c: "right-[38%] bottom-[14%] text-3xl", d: "60ms" },
          ].map((s, i) => (
            <span
              key={i}
              className={`animate-bob pointer-events-none absolute ${s.c}`}
              style={{ animationDelay: s.d }}
            >
              {s.e}
            </span>
          ))}

          {/* banner */}
          <div className="pointer-events-none absolute inset-x-0 top-12 flex justify-center px-6">
            <div className="glass-candy animate-pop rounded-[1.9rem] px-9 py-6 text-center">
              <h1 className="text-candy-gradient font-display text-4xl font-black tracking-tight sm:text-5xl">
                ✨ OKAY BADDIE ✨
              </h1>
              <p className="mt-2 font-body text-base font-semibold text-plum/85">
                Make him nervous on that date 💖
              </p>
            </div>
          </div>

          {/* let them slip back to the last step if they want */}
          <button
            type="button"
            onClick={prevStep}
            className="glass-candy animate-pop pointer-events-auto absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full px-5 py-2.5 font-display text-sm font-bold text-berry"
          >
            ← back
          </button>
        </div>
      )}

      {/* Face-shape result — read-only. The scan reports what it measured;
          the full per-shape breakdown lives in the sidebar badge. */}
      {shapeReveal && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center p-6">
          <div className="panel-candy animate-pop rounded-[2rem] px-10 py-8 text-center">
            <p className="font-display text-xs font-bold uppercase tracking-[0.2em] text-rose">
              ✨ Face shape detected
            </p>
            <h2 className="text-candy-gradient mt-1 font-display text-5xl font-black tracking-tight">
              {topGuess?.shape ?? "—"}
            </h2>
            <p className="mt-1.5 font-display text-sm font-bold text-berry/75">
              {topGuess ? `${Math.round(topGuess.confidence * 100)}% match` : ""}
              {faceShapeSamples > 1 && ` · ${faceShapeSamples} frames`}
            </p>
            <p className="mt-0.5 font-body text-[11px] font-semibold text-plum/60">
              {faceShapeLengthClass === "compact"
                ? "roughly as long as it is wide"
                : "longer than it is wide"}
            </p>
          </div>
        </div>
      )}

      {/* Nose profile capture. Roman / Greek / Hawk / Snub differ only in the
          dorsal line, which is invisible head-on — so ask for the turn. */}
      {awaitingNoseProfile && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-40 flex justify-center px-6">
          <div className="panel-candy animate-pop pointer-events-auto max-w-xs rounded-[1.75rem] px-6 py-4 text-center">
            <div className="animate-bob text-3xl">↩️</div>
            <p className="mt-1 font-display text-lg font-bold text-berry">
              Turn to the side
            </p>
            <p className="mt-0.5 font-body text-[11px] font-semibold text-plum/70">
              Your nose shape shows in profile
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-plum/15">
              <div
                className="h-full rounded-full bg-mint transition-all duration-150"
                style={{ width: `${Math.round(yawPct * 100)}%` }}
              />
            </div>
            <button
              type="button"
              onClick={() => setAwaitingNoseProfile(false)}
              className="btn-soft mt-2.5 rounded-full px-4 py-1.5 font-display text-xs font-bold"
            >
              skip
            </button>
          </div>
        </div>
      )}

      {/* Faux feature scan: a green sweep line + status pill (nose / eyes). */}
      {featureScanLabel && (
        <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
          <div className="scan-line" />
          <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center px-6">
            <div className="glass-candy animate-pop flex items-center gap-2.5 rounded-full px-5 py-2.5">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-mint" />
              <span className="font-display text-sm font-bold text-berry">
                {featureScanLabel}
              </span>
            </div>
          </div>
        </div>
      )}

      {flashing && (
        <div
          className="pointer-events-none absolute inset-0 z-40 bg-white"
          style={{ animation: "scanFlash 450ms ease-out forwards" }}
        />
      )}
    </>
  );
}
