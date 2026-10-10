/** The sound-wave mark (brand/mark.svg) in the current text colour, with the wordmark beside it. */
export function Logo({ size = 28, wordmark = true }: { size?: number; wordmark?: boolean }) {
  return (
    <span className="logo">
      <Mark size={size} />
      {wordmark && <span className="logo-word">Alexsay</span>}
    </span>
  );
}

/** Seven rounded bars, width half their pitch, fitting a circle so round icon crops keep every bar. */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      className={className}
      stroke="currentColor"
      strokeWidth="5.5"
      strokeLinecap="round"
      fill="none"
    >
      <line x1="17" y1="40.375" x2="17" y2="59.625" />
      <line x1="28" y1="32.125" x2="28" y2="67.875" />
      <line x1="39" y1="23.875" x2="39" y2="76.125" />
      <line x1="50" y1="14.25" x2="50" y2="85.75" />
      <line x1="61" y1="23.875" x2="61" y2="76.125" />
      <line x1="72" y1="32.125" x2="72" y2="67.875" />
      <line x1="83" y1="40.375" x2="83" y2="59.625" />
    </svg>
  );
}
