import { useState } from "react";
import {
  EYE_ZOOM_STEP_ID,
  REVEAL_STEP_ID,
  selectCurrentStep,
  useMakeupStore,
} from "../store/useMakeupStore";

/** Cute emoji per step, keyed by stepId (falls back to category, then a lippie). */
const STEP_ICON: Record<string, string> = {
  nose_contour: "👃",
  face_contour: "🖌️",
  blush: "🌸",
  eyeshadow_1: "🎨",
  eyeshadow_2: "🎨",
  tightlining: "👁️",
  eyeliner: "🖊️",
  false_lashes: "👁️",
  aegyo_sal: "😊",
  // category / legacy fallbacks
  contour: "🖌️",
  brighten: "✨",
  highlight: "✨",
};

function iconFor(stepId: string, category: string): string {
  return STEP_ICON[stepId] ?? STEP_ICON[category] ?? "💄";
}

/**
 * MakeupPanel — a slim, minimal "glow-up" bar for the GUIDE phase.
 *
 * Deliberately compact so it never covers the face. It's one row: circular
 * Back/Next, a media thumbnail (the step's reference photo when provided, else
 * a swatch/icon), the step name + a short instruction, plus tiny tappable
 * progress dots. A chevron collapses it to a tiny pill.
 *
 * Hidden entirely on the `eye_zoom_prompt` transition step — CameraMirror shows
 * the full-screen "get closer" prompt there instead.
 */
export default function MakeupPanel() {
  const step = useMakeupStore(selectCurrentStep);
  const steps = useMakeupStore((s) => s.makeupMap.steps);
  const currentStepIndex = useMakeupStore((s) => s.currentStepIndex);
  const nextStep = useMakeupStore((s) => s.nextStep);
  const prevStep = useMakeupStore((s) => s.prevStep);
  const goToStep = useMakeupStore((s) => s.goToStep);

  const [collapsed, setCollapsed] = useState(false);

  // The transition + final reveal own the whole screen (see CameraMirror) — no bar.
  if (!step || step.stepId === EYE_ZOOM_STEP_ID || step.stepId === REVEAL_STEP_ID)
    return null;

  const totalSteps = steps.length;
  const isFirst = currentStepIndex === 0;
  const isLast = currentStepIndex >= totalSteps - 1;
  const hasOverlays = step.overlays.length > 0;

  // Collapsed: just a tiny tap-to-expand pill, face fully visible.
  if (collapsed) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center p-3">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="glass-candy animate-pop pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2 font-display text-sm font-bold text-berry"
        >
          <span className="text-base">{iconFor(step.stepId, step.product.category)}</span>
          {step.name}
          <span className="text-berry/50">
            {currentStepIndex + 1}/{totalSteps} ▴
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 p-3">
      <div className="panel-candy animate-pop pointer-events-auto mx-auto max-w-md rounded-[1.5rem] px-3 py-2.5">
        {/* Tiny progress dots (tap to jump) + collapse chevron */}
        <div className="mb-1.5 flex items-center justify-between px-1">
          <div className="flex items-center gap-1.5">
            {steps.map((s, i) => (
              <button
                key={s.stepId}
                type="button"
                onClick={() => goToStep(i)}
                aria-label={s.name}
                aria-current={i === currentStepIndex}
                className={`rounded-full transition-all ${
                  i === currentStepIndex
                    ? "h-2 w-5 bg-rose"
                    : i < currentStepIndex
                      ? "h-2 w-2 bg-blush"
                      : "h-2 w-2 bg-plum/25"
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Minimize"
            className="px-1 font-display text-sm font-bold leading-none text-berry/50"
          >
            ▾
          </button>
        </div>

        {/* One compact row: Back · media · text · Next */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={prevStep}
            disabled={isFirst}
            aria-label="Back"
            className="btn-soft grid h-10 w-10 shrink-0 place-items-center rounded-full font-display text-lg font-bold"
          >
            ←
          </button>

          {/* Media: reference photo if provided, else swatch, else icon. */}
          {step.imageUrl ? (
            <img
              src={step.imageUrl}
              alt={`${step.name} reference`}
              className="h-10 w-10 shrink-0 rounded-xl object-cover ring-2 ring-white/70"
            />
          ) : hasOverlays ? (
            <span className="relative h-8 w-8 shrink-0 rounded-full ring-[3px] ring-white/70">
              <span
                className="absolute inset-0 rounded-full shadow-inner"
                style={{ backgroundColor: step.product.swatchColor }}
              />
              <span className="absolute left-1.5 top-1 h-2 w-2 rounded-full bg-white/70 blur-[0.5px]" />
            </span>
          ) : (
            <span className="glass-candy grid h-9 w-9 shrink-0 place-items-center rounded-full text-lg">
              {iconFor(step.stepId, step.product.category)}
            </span>
          )}

          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-sm font-bold leading-tight text-berry">
              {step.name}
              {hasOverlays && <span className="text-rose"> · {step.product.name}</span>}
            </p>
            <p className="line-clamp-2 text-[11px] font-medium leading-snug text-plum/80">
              {step.instruction}
            </p>
          </div>

          <button
            type="button"
            onClick={nextStep}
            disabled={isLast}
            aria-label={isLast ? "All done" : "Next"}
            className="btn-candy grid h-10 w-10 shrink-0 place-items-center rounded-full font-display text-lg font-bold"
          >
            {isLast ? "💖" : "→"}
          </button>
        </div>
      </div>
    </div>
  );
}
