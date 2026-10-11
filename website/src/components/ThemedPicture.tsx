import { Picture } from "./Picture";

interface Variant {
  large: string;
  small: string;
}

interface Props {
  night: Variant;
  day: Variant;
  alt: string;
  width: number;
  height: number;
  eager?: boolean;
  className?: string;
}

/** The night photo on the dark theme, the daylight one on the light theme; CSS shows one of the two. */
export function ThemedPicture({ night, day, alt, width, height, eager, className }: Props) {
  return (
    <>
      <Picture
        {...night}
        alt={alt}
        width={width}
        height={height}
        eager={eager}
        className={`${className ?? ""} only-dark`}
      />
      <Picture
        {...day}
        alt={alt}
        width={width}
        height={height}
        eager={eager}
        className={`${className ?? ""} only-light`}
      />
    </>
  );
}
