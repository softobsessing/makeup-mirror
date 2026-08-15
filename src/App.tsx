import CameraMirror from "./components/CameraMirror";
import Decor from "./components/Decor";
import MakeupPanel from "./components/MakeupPanel";
import TrackingHud from "./components/TrackingHud";
import { useMakeupStore } from "./store/useMakeupStore";

/**
 * App shell. Layers, bottom-to-top:
 *   1. CameraMirror  — mirrored video + canvas (AR surface) + scanner overlay
 *   2. Decor         — ambient floating hearts / sparkles
 *   3. TrackingHud   — top-center status pill
 *   4. Face-shape banner — top-left, shows the detected shape (GUIDE phase)
 *   5. MakeupPanel   — bottom step dashboard (GUIDE phase only)
 *   6. Permission gate — full-screen prompt when the camera is blocked
 */
export default function App() {
  const cameraPermission = useMakeupStore((s) => s.cameraPermission);
  const appState = useMakeupStore((s) => s.appState);
  const detectedFaceShape = useMakeupStore((s) => s.detectedFaceShape);
  const faceShapeScanned = useMakeupStore((s) => s.faceShapeScanned);
  const faceShapeRanking = useMakeupStore((s) => s.faceShapeRanking);
  const eyeShape = useMakeupStore((s) => s.eyeShape);
  const noseScanned = useMakeupStore((s) => s.noseScanned);
  const eyesScanned = useMakeupStore((s) => s.eyesScanned);
  const recalibrate = useMakeupStore((s) => s.recalibrate);
  const rescanEyes = useMakeupStore((s) => s.rescanEyes);
  const noseShape = useMakeupStore((s) => s.noseShape);
  const rescanNose = useMakeupStore((s) => s.rescanNose);

  return (
    <div className="relative h-full w-full overflow-hidden bg-gradient-to-b from-cotton to-lavender">
      <CameraMirror />
      <Decor />
      <TrackingHud />

      {/* Detected features — a stack of cute badges, top-left. Face shape shows
          immediately; nose / eye "types" reveal after their faux scans. */}
      {appState === "GUIDE" && detectedFaceShape && (
        <div className="absolute left-4 top-4 z-20 flex flex-col items-start gap-2 sm:left-6 sm:top-6">
          {/* Detected shape plus the full per-shape breakdown. Read-only: the
              scan reports what it measured and how confident it is, rather than
              asking the user to pick. */}
          {faceShapeScanned && (
            <div className="glass-candy animate-pop rounded-[1.25rem] px-4 py-2.5">
              <div className="flex items-center gap-3">
                <div>
                  <p className="font-display text-[10px] font-bold uppercase tracking-wider text-rose">
                    ✨ Your shape
                  </p>
                  <p className="font-display text-lg font-bold leading-none text-berry">
                    {detectedFaceShape}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={recalibrate}
                  className="btn-soft rounded-full px-3 py-1.5 font-display text-xs font-bold"
                >
                  Re-scan 🔄
                </button>
              </div>

              {faceShapeRanking && (
                <div className="mt-2 space-y-1 border-t border-white/60 pt-2">
                  {faceShapeRanking.map((r, i) => (
                    <div key={r.shape} className="flex items-center gap-1.5">
                      <span
                        className={`w-[4.6rem] font-display text-[10px] font-bold ${
                          i === 0 ? "text-berry" : "text-plum/65"
                        }`}
                      >
                        {r.shape}
                      </span>
                      {/* Bar makes the margin between shapes visible at a glance. */}
                      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-plum/15">
                        <span
                          className={`block h-full rounded-full ${
                            i === 0 ? "bg-rose" : "bg-blush"
                          }`}
                          style={{ width: `${Math.round(r.confidence * 100)}%` }}
                        />
                      </span>
                      <span
                        className={`w-7 text-right font-display text-[10px] font-bold tabular-nums ${
                          i === 0 ? "text-berry" : "text-plum/60"
                        }`}
                      >
                        {Math.round(r.confidence * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {noseScanned && noseShape && (
            <div className="glass-candy animate-pop rounded-[1.25rem] px-4 py-2">
              <div className="flex items-start justify-between gap-3">
                <p className="font-display text-[10px] font-bold uppercase tracking-wider text-rose">
                  👃 Your nose type
                </p>
                <button
                  type="button"
                  onClick={rescanNose}
                  className="btn-soft -mt-0.5 rounded-full px-2.5 py-1 font-display text-[10px] font-bold"
                >
                  Re-scan 🔄
                </button>
              </div>
              <p className="font-display text-base font-bold leading-tight text-berry">
                {noseShape.type}
                {!noseShape.hasProfile && (
                  <span className="ml-1 text-[10px] font-bold text-plum/55">partial</span>
                )}
              </p>
              <p className="mt-0.5 font-body text-[10px] font-semibold text-plum/60">
                {noseShape.reason}
              </p>
              {/* Runners-up: several nose types are the same measurement at
                  different strengths, so the margin matters. */}
              <div className="mt-1 space-y-0.5 border-t border-white/60 pt-1">
                {noseShape.ranked.slice(0, 3).map((r, i) => (
                  <p
                    key={r.type}
                    className={`font-body text-[10px] font-semibold ${
                      i === 0 ? "text-berry/85" : "text-plum/55"
                    }`}
                  >
                    {r.type} · {Math.round(r.confidence * 100)}%
                  </p>
                ))}
              </div>
              {!noseShape.hasProfile && (
                <p className="mt-1 font-body text-[10px] font-semibold text-rose/80">
                  turn to the side for the full read
                </p>
              )}
            </div>
          )}

          {eyesScanned && eyeShape && (
            <div className="glass-candy animate-pop rounded-[1.25rem] px-4 py-2">
              <div className="flex items-start justify-between gap-3">
                <p className="font-display text-[10px] font-bold uppercase tracking-wider text-rose">
                  👁️ Your eye type
                </p>
                <button
                  type="button"
                  onClick={rescanEyes}
                  className="btn-soft -mt-0.5 rounded-full px-2.5 py-1 font-display text-[10px] font-bold"
                >
                  Re-scan 🔄
                </button>
              </div>
              <p className="font-display text-base font-bold leading-tight text-berry">
                {eyeShape.summary}
              </p>
              {/* The measurements behind it, so the reading is inspectable. */}
              <div className="mt-1 space-y-0.5 border-t border-white/60 pt-1">
                {[
                  ["tilt", eyeShape.tilt.value, `${eyeShape.metrics.tiltDeg.toFixed(1)}°`],
                  ["set", eyeShape.spacing.value, eyeShape.metrics.spacingRatio.toFixed(2)],
                  ["shape", eyeShape.aperture.value, eyeShape.metrics.apertureRatio.toFixed(2)],
                  ...(eyeShape.lid
                    ? [["lid", eyeShape.lid.value, `${Math.round(eyeShape.lid.confidence * 100)}%`]]
                    : [["lid", "move closer", "too small to read"]]),
                ].map(([k, v, n]) => (
                  <p key={k} className="font-body text-[10px] font-semibold text-plum/60">
                    {k}: <span className="text-berry/80">{v}</span> ({n})
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {appState === "GUIDE" && <MakeupPanel />}

      {cameraPermission === "denied" && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-gradient-to-b from-cotton to-lavender p-6 text-center">
          <div className="panel-candy animate-pop max-w-md rounded-[2rem] p-8">
            <div className="mb-3 text-5xl">🙈</div>
            <h1 className="text-candy-gradient mb-3 font-display text-3xl font-bold">
              Camera's feeling shy!
            </h1>
            <p className="font-body font-semibold text-plum/85">
              Your Glow-Up Mirror needs your camera to work its magic. Turn on camera
              permission in your browser, then reload the page 💕
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
