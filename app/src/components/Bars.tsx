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
const FRAME_MS = 33;

const COLOURS: Record<string, string> = {
  idle: "var(--gray-8)",
  connecting: "var(--accent-8)",
  listening: "var(--accent-9)",
  speaking: "var(--accent-9)",
  closed: "var(--gray-8)",
  error: "var(--red-9)",
};

/**
 * The logo bars as a live meter: at rest they hold the logo's shape and breathe; while someone
 * talks each bar rises with the level, the middle ones most, with a little drift so it reads as sound.
 */
export function Bars({ status, level }: Props) {
  const bars = useRef<(SVGLineElement | null)[]>([]);
  const state = useRef({ status, level, smoothed: 0 });
  state.current.status = status;
  state.current.level = level;

  useEffect(() => {
    let frame = 0;
    let last = 0;
    const start = performance.now();
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) {
        return;
      }
      last = now;
      const t = (now - start) / 1000;
      const { status, level } = state.current;
      const target = status === "idle" || status === "closed" || status === "error" ? 0 : level();
      state.current.smoothed += (target - state.current.smoothed) * (target > state.current.smoothed ? 0.5 : 0.12);
      const energy = state.current.smoothed;
      bars.current.forEach((bar, i) => {
        if (!bar) {
          return;
        }
        const centreness = 1 - Math.abs(i - 3) / 3.5;
        const breathing = 1 + Math.sin(t * 1.6 + i * 0.7) * 0.03;
        const wobble = 0.75 + 0.25 * Math.sin(t * 9 + i * 1.9) * Math.sin(t * 5.3 + i);
        const grow = energy * (0.35 + centreness) * wobble;
        const height = Math.min(92, (REST_HEIGHTS[i] ?? 0) * breathing * (1 + grow));
        bar.setAttribute("y1", String(50 - height / 2 + WIDTH / 2));
        bar.setAttribute("y2", String(50 + height / 2 - WIDTH / 2));
      });
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <svg
      className="bars"
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Assistant ${status}`}
      stroke={COLOURS[status] ?? COLOURS.idle}
      strokeWidth={WIDTH}
      strokeLinecap="round"
      fill="none"
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
