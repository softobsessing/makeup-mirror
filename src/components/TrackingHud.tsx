import {
  EYE_ZOOM_STEP_ID,
  REVEAL_STEP_ID,
  selectCurrentStepId,
  useMakeupStore,
} from "../store/useMakeupStore";

/**
 * Sassy "mirror talks back" line shown per step. The messages are SHIFTED by one
 * slide: each step's line acknowledges the work done on the PREVIOUS step (the
 * mirror reacting after you finish a step). Calibration + nose_contour both read
 * "dang you look rough" (nothing's been done yet). The final reveal shows its own
 * OKAY BADDIE banner, so it has no HUD line.
 */
const STEP_HUD: Record<string, string> = {
  face_contour: "dang you look rough 😭",
  nose_contour: "looking snatched ✨",
  blush: "no rhinoplasty needed 💅",
  eyeshadow_1: "why you blushing 😳",
  eyeshadow_2: "make those eyes pop 👁️",
  tightlining: "now make them pop even more 🤩",
  eyeliner: "sexy stare 😏",
  false_lashes: "eyes looking humungo 👀",
  aegyo_sal: "bat them lashes 👁️",
};

/**
 * Top status HUD. Reflects camera permission, tracking, and (coarse) face
 * presence. This is the only place per-frame info surfaces into React, and even
 * then `faceDetected` only flips on transitions (see the store guard).
 */
export default function TrackingHud() {
  const cameraPermission = useMakeupStore((s) => s.cameraPermission);
  const cameraError = useMakeupStore((s) => s.cameraError);
  const trackingActive = useMakeupStore((s) => s.trackingActive);
  const faceDetected = useMakeupStore((s) => s.faceDetected);
  const appState = useMakeupStore((s) => s.appState);
  const currentStepId = useMakeupStore(selectCurrentStepId);

  // The eye-zoom transition and the final reveal own the screen with their own
  // messaging — hide the status pill there so it doesn't peek out behind them.
  if (
    appState === "GUIDE" &&
    (currentStepId === REVEAL_STEP_ID || currentStepId === EYE_ZOOM_STEP_ID)
  ) {
    return null;
  }

  let label = "Getting ready… 🪄";
  let dotClass = "bg-blush animate-pulse";

  if (cameraPermission === "denied") {
    label = "Camera's shy — enable access & reload 🙈";
    dotClass = "bg-rose";
  } else if (cameraPermission === "pending") {
    label = "Asking for your camera… 📸";
    dotClass = "bg-blush animate-pulse";
  } else if (trackingActive) {
    if (faceDetected) {
      // Per-step sassy line while guiding; on the scan screen the mirror opens
      // with "dang you look rough" (before any makeup).
      label =
        appState === "GUIDE" && currentStepId
          ? STEP_HUD[currentStepId] ?? "dang you look rough 😭"
          : "dang you look rough 😭";
      dotClass = "bg-mint";
    } else {
      label = "Center your pretty face 🌸";
      dotClass = "bg-blush animate-pulse";
    }
  } else if (cameraError) {
    label = `Oops: ${cameraError}`;
    dotClass = "bg-rose";
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-4 sm:p-6">
      <div className="glass-candy flex items-center gap-2.5 rounded-full px-5 py-2.5">
        <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
        <span className="font-display text-sm font-semibold text-berry">{label}</span>
      </div>
    </div>
  );
}
