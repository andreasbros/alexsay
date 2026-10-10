/** The AY mark: the A's right leg is the Y's left arm. Colours follow the current theme. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      strokeWidth="13"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 84 L38 24 L66 84 L94 24" />
      <path d="M66 84 L66 110" />
      <path d="M23 62 L53 62" />
    </svg>
  );
}
