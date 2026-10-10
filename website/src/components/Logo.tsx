/** The AY mark (brand/mark.svg) in the current text colour, with the wordmark beside it. */
export function Logo({ size = 28, wordmark = true }: { size?: number; wordmark?: boolean }) {
  return (
    <span className="logo">
      <Mark size={size} />
      {wordmark && <span className="logo-word">Alexsay</span>}
    </span>
  );
}

export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" className={className}>
      <rect width="120" height="120" rx="26" className="logo-tile" />
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="logo-glyph"
        transform="translate(12 10) scale(0.8)"
      >
        <path d="M10 84 L38 24 L66 84 L94 24" />
        <path d="M66 84 L66 110" />
        <path d="M23 62 L53 62" />
      </g>
    </svg>
  );
}
