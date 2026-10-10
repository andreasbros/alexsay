import { useEffect, useRef } from "react";
import type { LiveStatus } from "../lib/live";

interface Props {
  status: LiveStatus | "idle";
  /** Current loudness 0 to 1 of whoever is talking; the sphere swells and ripples with it. */
  level: () => number;
}

const POINTS = 120;
/** Half the display rate is plenty for a blob and leaves the main thread free for audio. */
const FRAME_MS = 33;

/** A liquid sphere: a radial-gradient blob whose rim is pushed by a few drifting waves scaled by the audio level. */
export function Sphere({ status, level }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ status, level, smoothed: 0 });
  state.current.status = status;
  state.current.level = level;

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) {
      return;
    }
    let frame = 0;
    let last = 0;
    const start = performance.now();
    const draw = (now: number) => {
      if (now - last < FRAME_MS) {
        frame = requestAnimationFrame(draw);
        return;
      }
      last = now;
      const t = (now - start) / 1000;
      const { status, level } = state.current;
      const target = status === "idle" || status === "closed" ? 0 : level();
      state.current.smoothed += (target - state.current.smoothed) * (target > state.current.smoothed ? 0.35 : 0.08);
      render(context, element, t, state.current.smoothed, status);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvas} className="sphere" role="img" aria-label={`Assistant ${status}`} />;
}

type Palette = [string, string, string];
const IDLE: Palette = ["#818cf8", "#6366f1", "#312e81"];
const PALETTE: Record<string, Palette> = {
  idle: IDLE,
  connecting: ["#a5b4fc", "#6366f1", "#312e81"],
  listening: ["#67e8f9", "#6366f1", "#1e1b4b"],
  speaking: ["#f9a8d4", "#818cf8", "#312e81"],
  closed: ["#94a3b8", "#64748b", "#1e293b"],
  error: ["#fca5a5", "#ef4444", "#450a0a"],
};

function render(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, t: number, level: number, status: string) {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const centre = size / 2;
  const breathing = 1 + Math.sin(t * 1.4) * 0.015;
  const radius = size * 0.3 * breathing * (1 + level * 0.18);
  const ripple = 0.02 + level * 0.12;
  const [light, mid, dark] = PALETTE[status] ?? IDLE;

  // A soft halo drawn as a gradient disc: far cheaper than a canvas shadow blur every frame
  const haloRadius = radius * (1.25 + level * 0.3);
  const halo = ctx.createRadialGradient(centre, centre, radius * 0.9, centre, centre, haloRadius);
  halo.addColorStop(0, withAlpha(mid, 0.35 + level * 0.3));
  halo.addColorStop(1, withAlpha(mid, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(centre, centre, haloRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i <= POINTS; i++) {
    const angle = (i / POINTS) * Math.PI * 2;
    const wave =
      Math.sin(angle * 3 + t * 1.7) * 0.5 + Math.sin(angle * 5 - t * 2.3) * 0.3 + Math.sin(angle * 8 + t * 3.1) * 0.2;
    const r = radius * (1 + wave * ripple);
    const x = centre + Math.cos(angle) * r;
    const y = centre + Math.sin(angle) * r;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  const gradient = ctx.createRadialGradient(
    centre - radius * 0.35,
    centre - radius * 0.4,
    radius * 0.1,
    centre,
    centre,
    radius * 1.05,
  );
  gradient.addColorStop(0, light);
  gradient.addColorStop(0.55, mid);
  gradient.addColorStop(1, dark);
  ctx.fillStyle = gradient;
  ctx.fill();

  // A soft highlight that drifts, so the surface reads as liquid rather than flat
  const hx = centre + Math.cos(t * 0.6) * radius * 0.25;
  const hy = centre - radius * 0.45 + Math.sin(t * 0.8) * radius * 0.1;
  const highlight = ctx.createRadialGradient(hx, hy, 0, hx, hy, radius * 0.6);
  highlight.addColorStop(0, "rgba(255,255,255,0.45)");
  highlight.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = highlight;
  ctx.beginPath();
  ctx.arc(centre, centre, radius * 1.1, 0, Math.PI * 2);
  ctx.fill();
}

/** "#rrggbb" plus an alpha, as canvas gradients need. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha.toFixed(3)})`;
}
