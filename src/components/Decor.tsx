/**
 * Decor — ambient floating hearts & sparkles for the "beauty game" vibe.
 *
 * Purely decorative: sits above the camera but ignores pointer events so it
 * never blocks the mirror or the controls. Kept toward the screen edges so it
 * frames the face without covering it.
 */

interface Sprite {
  emoji: string;
  className: string; // absolute position + size
  delay: string;
  duration: string;
}

const SPRITES: Sprite[] = [
  { emoji: "🎀", className: "left-3 top-24 text-3xl", delay: "0s", duration: "5.5s" },
  { emoji: "✨", className: "left-8 top-1/2 text-2xl", delay: "1.2s", duration: "4.5s" },
  { emoji: "💗", className: "left-4 bottom-52 text-2xl", delay: "0.6s", duration: "6s" },
  { emoji: "🌸", className: "right-4 top-28 text-3xl", delay: "0.3s", duration: "5s" },
  { emoji: "⭐", className: "right-9 top-1/2 text-xl", delay: "1.8s", duration: "4.8s" },
  { emoji: "💖", className: "right-5 bottom-56 text-2xl", delay: "0.9s", duration: "5.8s" },
  { emoji: "✨", className: "left-1/3 top-16 text-lg", delay: "2.1s", duration: "4.2s" },
  { emoji: "✨", className: "right-1/3 bottom-40 text-lg", delay: "1.5s", duration: "5.2s" },
];

export default function Decor() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {SPRITES.map((s, i) => (
        <span
          key={i}
          className={`absolute animate-floaty select-none drop-shadow-[0_2px_6px_rgba(200,30,115,0.35)] ${s.className}`}
          style={{ animationDelay: s.delay, animationDuration: s.duration }}
          aria-hidden
        >
          {s.emoji}
        </span>
      ))}
    </div>
  );
}
