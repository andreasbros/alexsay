import { Flex, Text } from "@radix-ui/themes";
import { useState } from "react";

interface Brand {
  slug: string;
  name: string;
  /** The mark takes the text colour (Apple's is black on white), so it is drawn as a mask rather than an image. */
  masked?: boolean;
}

/** What the assistant will connect to next, drawn with each brand's own mark. */
export const COMING_SOON: Brand[] = [
  { slug: "apple", name: "Apple Home", masked: true },
  { slug: "googlehome", name: "Google Home" },
  { slug: "claude", name: "Claude" },
  { slug: "googlegemini", name: "Gemini" },
];

const SIZE = 44;

/**
 * The marks sit dimmed and grey; tapping one lights it up in its colours and says what it is and that it is
 * coming soon. One at a time, so the row stays quiet.
 */
export function ComingSoon() {
  const [lit, setLit] = useState<string | null>(null);
  return (
    <Flex gap="6" wrap="wrap" align="start">
      {COMING_SOON.map((brand) => {
        const on = lit === brand.slug;
        return (
          <Flex key={brand.slug} direction="column" align="center" gap="2" style={{ minWidth: 96 }}>
            <button
              type="button"
              className="brand-mark"
              aria-label={`${brand.name}: coming soon`}
              aria-pressed={on}
              onClick={() => setLit(on ? null : brand.slug)}
              style={{
                filter: on ? "none" : "grayscale(1)",
                opacity: on ? 1 : 0.4,
                transition: "filter 0.2s, opacity 0.2s, transform 0.2s",
                transform: on ? "scale(1.08)" : undefined,
              }}
            >
              {brand.masked ? (
                <span
                  aria-hidden
                  style={{
                    display: "block",
                    width: SIZE,
                    height: SIZE,
                    backgroundColor: "currentColor",
                    maskImage: `url(/logos/${brand.slug}.svg)`,
                    WebkitMaskImage: `url(/logos/${brand.slug}.svg)`,
                    maskRepeat: "no-repeat",
                    WebkitMaskRepeat: "no-repeat",
                    maskSize: "contain",
                    WebkitMaskSize: "contain",
                    maskPosition: "center",
                    WebkitMaskPosition: "center",
                  }}
                />
              ) : (
                <img src={`/logos/${brand.slug}.svg`} alt="" width={SIZE} height={SIZE} />
              )}
            </button>
            <Text size="2" weight={on ? "medium" : "regular"} color={on ? undefined : "gray"}>
              {brand.name}
            </Text>
            {on && (
              <Text size="1" color="gray">
                Coming soon
              </Text>
            )}
          </Flex>
        );
      })}
    </Flex>
  );
}
