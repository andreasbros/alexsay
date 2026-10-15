/** "3 min ago" style wording for last-seen stamps; null when the speaker never called home. */
export function ago(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) {
    return "never";
  }
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} h ago`;
  }
  return `${Math.round(hours / 24)} days ago`;
}

/** The speaker software that first takes drop-ins from the app. */
export const DROP_IN_SINCE = "0.1.4";

/** True when `version` (as the speaker reports it, "0.1.4") is `min` or newer; unknown versions are not. */
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

export const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());

/** What an alarm is called in a list: its label, or what it is ("Timer", "Reminder: bins"). */
export function alarmTitle(alarm: { kind: string; label: string; message?: string }): string {
  const kind = alarm.kind.charAt(0).toUpperCase() + alarm.kind.slice(1);
  if (alarm.kind === "reminder" && alarm.message) {
    return `Reminder: ${alarm.message}`;
  }
  return alarm.label ? `${alarm.label.charAt(0).toUpperCase()}${alarm.label.slice(1)}` : kind;
}
