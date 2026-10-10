interface PictureProps {
  large: string;
  small: string;
  alt: string;
  width: number;
  height: number;
  eager?: boolean;
  className?: string;
}

/** A responsive render: the 800 px file below ~900 px viewports, the 1600 px one above. */
export function Picture({ large, small, alt, width, height, eager = false, className }: PictureProps) {
  return (
    <img
      className={className}
      src={large}
      srcSet={`${small} 800w, ${large} 1600w`}
      sizes="(max-width: 900px) 100vw, 50vw"
      alt={alt}
      width={width}
      height={height}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={eager ? "high" : "auto"}
    />
  );
}
