interface ScannerOverlayProps {
  /** Called when the user taps "Scan Face". */
  onScan: () => void;
  /** Whether a face is currently in frame (enables the scan button). */
  faceDetected: boolean;
}

/**
 * Calibration UI shown during the CALIBRATING phase. It sits ON TOP of the
 * mirrored camera layer (and is itself NOT mirrored, so text reads correctly).
 * The glowing face silhouette itself is drawn on the canvas by CameraMirror;
 * this layer adds the cute instructions and the candy scan button.
 */
export default function ScannerOverlay({ onScan, faceDetected }: ScannerOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-between p-6 sm:p-8">
      {/* Title */}
      <div className="glass-candy animate-pop mt-10 rounded-[1.75rem] px-6 py-4 text-center">
        <h1 className="text-candy-gradient font-display text-3xl font-bold tracking-tight">
          ✨ UNCHOP YOURSELF ✨
        </h1>
        <p className="mt-1 font-body text-sm font-semibold text-plum/80">
          Pop your face in the outline &amp; look straight ahead 💕
        </p>
      </div>

      {/* Status + scan button */}
      <div className="pointer-events-auto mb-6 flex w-full max-w-md flex-col items-center gap-4">
        <div
          className={`glass-candy flex items-center gap-2 rounded-full px-5 py-2 font-display text-sm font-bold transition ${
            faceDetected ? "text-mint" : "text-plum/70"
          }`}
        >
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              faceDetected ? "bg-mint" : "animate-pulse bg-blush"
            }`}
          />
          {faceDetected ? "Found you! Ready to scan 💖" : "Center your pretty face 🌸"}
        </div>

        <button
          type="button"
          onClick={onScan}
          disabled={!faceDetected}
          className="btn-candy relative h-16 w-full max-w-xs rounded-[1.5rem] font-display text-xl font-bold"
        >
          {faceDetected && (
            <span
              className="pointer-events-none absolute inset-0 rounded-[1.5rem] ring-4 ring-white/60"
              style={{ animation: "scanPulse 1.6s ease-in-out infinite" }}
            />
          )}
          Scan My Face 💄
        </button>
      </div>
    </div>
  );
}
