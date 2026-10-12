import { useEffect, useRef, useState } from "react";
import { ACTS, type Act, PROMPT } from "../content/terminal";

const TYPE_MS = 42;
const PAUSE_BETWEEN_ACTS = 1600;
const PAUSE_BEFORE_REPLAY = 7000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

interface Writer {
  write: (text: string) => void;
}

async function play(term: Writer, act: Act, signal: AbortSignal, typing: boolean): Promise<void> {
  term.write(PROMPT);
  for (const ch of act.command) {
    term.write(ch);
    if (typing) {
      await sleep(TYPE_MS + Math.random() * 40, signal);
    }
  }
  term.write("\r\n");
  for (const line of act.lines) {
    if (typing) {
      await sleep(line.delay, signal);
    }
    term.write(`${line.text}\r\n`);
  }
}

/**
 * A real terminal (xterm.js) playing the install, wake word training and a conversation, tilting in
 * 3D between acts. It loads only once scrolled into view; with reduced motion it shows the whole
 * session at once and stays still.
 */
export function DevTerminal() {
  const stage = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const [act, setAct] = useState(0);
  const [visible, setVisible] = useState(false);
  const [still, setStill] = useState(false);

  useEffect(() => {
    const node = stage.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setVisible(true), {
      rootMargin: "200px",
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = screen.current;
    if (!visible || !host) {
      return;
    }
    const controller = new AbortController();
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    setStill(still);
    let dispose = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      if (controller.signal.aborted) {
        return;
      }
      const term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        disableStdin: true,
        fontFamily: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
        fontSize: window.innerWidth < 640 ? 10.5 : 13,
        lineHeight: 1.35,
        scrollback: 400,
        theme: {
          background: "#0d0f17",
          foreground: "#d7dae5",
          cursor: "#a5b4fc",
          green: "#4ade80",
          blue: "#818cf8",
          cyan: "#22d3ee",
          magenta: "#f472b6",
          yellow: "#facc15",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      const onResize = () => fit.fit();
      window.addEventListener("resize", onResize);
      dispose = () => {
        window.removeEventListener("resize", onResize);
        term.dispose();
      };
      try {
        do {
          term.reset();
          for (const [index, current] of ACTS.entries()) {
            setAct(index);
            await play(term, current, controller.signal, !still);
            if (!still) {
              await sleep(PAUSE_BETWEEN_ACTS, controller.signal);
            }
          }
          term.write(PROMPT);
          if (!still) {
            await sleep(PAUSE_BEFORE_REPLAY, controller.signal);
          }
        } while (!still);
      } catch {
        // Unmounted mid-animation
      }
    })();
    return () => {
      controller.abort();
      dispose();
    };
  }, [visible]);

  const pose = still ? { x: 0, y: 0, z: 0 } : (ACTS[act]?.pose ?? { x: 0, y: 0, z: 0 });
  return (
    <div className="term-stage" ref={stage}>
      <div
        className="term-window"
        style={{ transform: `rotateX(${pose.x}deg) rotateY(${pose.y}deg) rotateZ(${pose.z}deg)` }}
      >
        <div className="term-bar" aria-hidden="true">
          <span />
          <span />
          <span />
          <p>robin@kitchen: ~</p>
        </div>
        <div
          className="term-screen"
          ref={screen}
          role="img"
          aria-label="A terminal installing alexsay, training the wake word, then running it: the speaker hears its name, answers the time, dims the living room lights and offers more help."
        />
      </div>
    </div>
  );
}
