import { useEffect, useRef } from "react";
import { debugLog, isDebug } from "../lib/debug";
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

/** One colour per state, set through style so the theme tokens resolve in every browser. */
const COLOURS: Record<string, string> = {
  idle: "var(--gray-8)",
  connecting: "var(--accent-8)",
  listening: "var(--cyan-9)",
  thinking: "var(--pink-8)",
  speaking: "var(--accent-9)",
  lost: "var(--amber-9)",
  closed: "var(--gray-8)",
  error: "var(--red-9)",
};

/**
 * The logo bars as a live meter. Idle, they breathe gently; in a conversation, silence holds the
 * logo's shape exactly. Sound makes them
 * jump at once and settle slowly, the middle bars most, each with its own flutter; thinking sends a
 * wave travelling across them; the whole mark swells with the energy. Plain strokes only: gradients
 * and filters did not render on every phone.
 */
export function Bars({ status, level }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const bars = useRef<(SVGLineElement | null)[]>([]);
  const state = useRef({ status, level, energy: 0, lastLog: 0 });
  state.current.status = status;
  state.current.level = level;

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
      // Below a hair of energy the bars snap to rest rather than hovering around it
      const energy = state.current.energy < 0.015 ? 0 : state.current.energy;
      const thinking = status === "thinking";
      bars.current.forEach((bar, i) => {
        if (!bar) {
          return;
        }
        const centreness = 1 - Math.abs(i - 3) / 3.5;
        // Out of a conversation the mark breathes slowly; in one, silence is the logo exactly and
        // motion comes only from sound (or the thinking wave)
        const breathing = live ? 1 : 1 + Math.sin(t * 1.6 + i * 0.7) * 0.03;
        const flutter = 0.7 + 0.3 * Math.sin(t * 11 + i * 1.9) * Math.sin(t * 6.3 + i);
        const wave = thinking ? 0.45 * (0.5 + 0.5 * Math.sin(t * 6 - i * 0.9)) : 0;
        const grow = energy * (0.5 + 1.3 * centreness) * flutter + wave;
        const height = Math.min(MAX_HEIGHT, (REST_HEIGHTS[i] ?? 0) * breathing * (1 + grow));
        bar.setAttribute("y1", (50 - height / 2 + WIDTH / 2).toFixed(2));
        bar.setAttribute("y2", (50 + height / 2 - WIDTH / 2).toFixed(2));
      });
      if (svg.current) {
        svg.current.style.transform = `scale(${(1 + energy * 0.08).toFixed(3)})`;
      }
      if (isDebug() && (energy > 0 || thinking) && now - state.current.lastLog > 200) {
        state.current.lastLog = now;
        const heights = bars.current.map((bar) =>
          bar ? (Number(bar.getAttribute("y2")) - Number(bar.getAttribute("y1"))).toFixed(0) : "?",
        );
        debugLog(
          `bars status=${status} target=${target.toFixed(2)} energy=${energy.toFixed(2)} heights=${heights.join(",")}`,
        );
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
      style={{ stroke: COLOURS[status] ?? COLOURS.idle }}
    >
      {REST_HEIGHTS.map((height, i) => {
        const x = 50 + (i - 3) * PITCH;
        return (
          <line
            // biome-ignore lint/suspicious/noArrayIndexKey: the bars are a fixed set
            key={i}
            ref={(el) => {
              bars.current[i] = el;
            }}
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
