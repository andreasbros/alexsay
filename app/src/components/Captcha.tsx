import { useEffect, useRef } from "react";

interface Turnstile {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  reset(widget: string): void;
  remove(widget: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<Turnstile | undefined> | null = null;

function loadTurnstile(): Promise<Turnstile | undefined> {
  loading ??= new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => {
      loading = null;
      resolve(undefined);
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Cloudflare Turnstile, shown only when the server asks for it. Tokens are single use: bump
 * `resetKey` after each submit to get a fresh one.
 */
export function Captcha({
  siteKey,
  resetKey,
  onToken,
}: {
  siteKey: string;
  resetKey: number;
  onToken: (token: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const handler = useRef(onToken);
  handler.current = onToken;

  useEffect(() => {
    let cancelled = false;
    void loadTurnstile().then((turnstile) => {
      if (cancelled || !turnstile || !box.current) {
        return;
      }
      widget.current = turnstile.render(box.current, {
        sitekey: siteKey,
        theme: "auto",
        callback: (token: string) => handler.current(token),
        "expired-callback": () => handler.current(""),
        "error-callback": () => handler.current(""),
      });
    });
    return () => {
      cancelled = true;
      if (widget.current) {
        window.turnstile?.remove(widget.current);
        widget.current = null;
      }
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey > 0 && widget.current) {
      handler.current("");
      window.turnstile?.reset(widget.current);
    }
  }, [resetKey]);

  return <div ref={box} style={{ minHeight: 65 }} />;
}
