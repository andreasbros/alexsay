import { useEffect, useRef } from "react";
import type { LiveStatus } from "../lib/live";

interface Props {
  status: LiveStatus | "idle";
  /** Current loudness 0 to 1 of whoever is talking. */
  level: () => number;
}

/** The logo's proportions: seven bars, half a pitch wide, heights in pitches. */
const PITCH = 11;
const WIDTH = PITCH / 2;
const REST_HEIGHTS = [2.25, 3.75, 5.25, 7, 5.25, 3.75, 2.25].map((h) => h * PITCH);
const MAX_HEIGHT = 94;

/** Gradient stops per state: who is talking sets the mood. */
type Mood = [string, string];
const IDLE: Mood = ["var(--gray-8)", "var(--gray-7)"];
const MOODS: Record<string, Mood> = {
  idle: IDLE,
  connecting: ["var(--accent-8)", "var(--accent-6)"],
  listening: ["var(--cyan-9)", "var(--accent-9)"],
  thinking: ["var(--accent-8)", "var(--pink-8)"],
  speaking: ["var(--accent-9)", "var(--pink-9)"],
  lost: ["var(--amber-8)", "var(--gray-7)"],
  closed: ["var(--gray-8)", "var(--gray-7)"],
  error: ["var(--red-9)", "var(--red-8)"],
};

/**
 * The logo bars as a live meter. At rest they hold the logo's shape and breathe. Sound makes them
 * jump at once and settle slowly, the middle bars most, each with its own flutter; thinking sends a
 * wave travelling across them; the whole mark glows and swells with the energy.
 */
export function Bars({ status, level }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const bars = useRef<(SVGLineElement | null)[]>([]);
  const state = useRef({ status, level, energy: 0, peak: 0 });
  state.current.status = status;
  state.current.level = level;
  const [from, to] = MOODS[status] ?? IDLE;

  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const t = (now - start) / 1000;
      const { status, level } = state.current;
      const live = status === "listening" || status === "speaking" || status === "thinking" || status === "connecting";
      const target = live ? level() : 0;
      // Instant attack, slow release: the bars jump on a syllable and sink between words
      state.current.energy += (target - state.current.energy) * (target > state.current.energy ? 0.9 : 0.1);
      state.current.peak = Math.max(state.current.peak * 0.97, state.current.energy);
      const energy = state.current.energy;
      const thinking = status === "thinking";
      bars.current.forEach((bar, i) => {
        if (!bar) {
          return;
        }
        const centreness = 1 - Math.abs(i - 3) / 3.5;
        const breathing = 1 + Math.sin(t * 1.6 + i * 0.7) * 0.03;
        const flutter = 0.7 + 0.3 * Math.sin(t * 11 + i * 1.9) * Math.sin(t * 6.3 + i);
        const wave = thinking ? 0.45 * (0.5 + 0.5 * Math.sin(t * 6 - i * 0.9)) : 0;
        const grow = energy * (0.5 + 1.3 * centreness) * flutter + wave;
        const height = Math.min(MAX_HEIGHT, (REST_HEIGHTS[i] ?? 0) * breathing * (1 + grow));
        bar.setAttribute("y1", String(50 - height / 2 + WIDTH / 2));
        bar.setAttribute("y2", String(50 + height / 2 - WIDTH / 2));
      });
      const element = svg.current;
      if (element) {
        const glow = live ? 4 + state.current.peak * 26 : 0;
        element.style.filter = glow > 0 ? `drop-shadow(0 0 ${glow.toFixed(1)}px var(--bars-glow))` : "none";
        element.style.transform = `scale(${(1 + energy * 0.06).toFixed(3)})`;
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <svg
      ref={svg}
      className="bars"
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Assistant ${status}`}
      strokeWidth={WIDTH}
      strokeLinecap="round"
      fill="none"
      style={{ "--bars-glow": from } as React.CSSProperties}
    >
      <defs>
        <linearGradient id="bars-mood" x1="0" y1="0" x2="0" y2="1">
          {/* CSS variables only resolve through style, never through SVG presentation attributes */}
          <stop offset="0" style={{ stopColor: from }} />
          <stop offset="1" style={{ stopColor: to }} />
        </linearGradient>
      </defs>
      {REST_HEIGHTS.map((height, i) => {
        const x = 50 + (i - 3) * PITCH;
        return (
          <line
            // biome-ignore lint/suspicious/noArrayIndexKey: the bars are a fixed set
            key={i}
            ref={(el) => {
              bars.current[i] = el;
            }}
            stroke="url(#bars-mood)"
            x1={x}
            x2={x}
            y1={50 - height / 2 + WIDTH / 2}
            y2={50 + height / 2 - WIDTH / 2}
          />
        );
      })}
    </svg>
  );
}
