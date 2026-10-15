/** True when `version` (as a speaker reports it, "0.1.6") is `min` or newer; unknown versions are not. */
export function atLeastVersion(version: string | null | undefined, min: string): boolean {
  const parse = (text: string) =>
    text
      .trim()
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10));
  const have = version ? parse(version) : [];
  const want = parse(min);
  if (have.length === 0 || have.some(Number.isNaN)) {
    return false;
  }
  for (let i = 0; i < Math.max(have.length, want.length); i += 1) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

/** The speaker software that keeps its own GPT-Live session on calls it takes, instead of a server seat. */
export const CARRIES_ASSISTANT_SINCE = "0.1.6";
export const speakerCarriesAssistant = (firmware: string | null | undefined): boolean =>
  atLeastVersion(firmware, CARRIES_ASSISTANT_SINCE);
