/** Locales offered in Settings; any other saved value is shown as is. */
export const LOCALES: { code: string; name: string }[] = [
  { code: "en-GB", name: "English (United Kingdom)" },
  { code: "en-US", name: "English (United States)" },
  { code: "en-IE", name: "English (Ireland)" },
  { code: "en-AU", name: "English (Australia)" },
  { code: "en-CA", name: "English (Canada)" },
  { code: "de-DE", name: "Deutsch (Deutschland)" },
  { code: "de-AT", name: "Deutsch (Österreich)" },
  { code: "de-CH", name: "Deutsch (Schweiz)" },
  { code: "fr-FR", name: "Français (France)" },
  { code: "es-ES", name: "Español (España)" },
  { code: "it-IT", name: "Italiano (Italia)" },
  { code: "nl-NL", name: "Nederlands (Nederland)" },
  { code: "pt-PT", name: "Português (Portugal)" },
  { code: "pt-BR", name: "Português (Brasil)" },
  { code: "pl-PL", name: "Polski (Polska)" },
  { code: "sv-SE", name: "Svenska (Sverige)" },
  { code: "da-DK", name: "Dansk (Danmark)" },
  { code: "nb-NO", name: "Norsk (Norge)" },
  { code: "fi-FI", name: "Suomi (Suomi)" },
  { code: "cs-CZ", name: "Čeština (Česko)" },
  { code: "el-GR", name: "Ελληνικά (Ελλάδα)" },
  { code: "tr-TR", name: "Türkçe (Türkiye)" },
  { code: "uk-UA", name: "Українська (Україна)" },
  { code: "ja-JP", name: "日本語 (日本)" },
];

const FALLBACK_TIMEZONES = [
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Lisbon",
  "Europe/Warsaw",
  "Europe/Stockholm",
  "Europe/Athens",
  "Europe/Kyiv",
  "Europe/Istanbul",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** Every zone the browser knows, or a short list where it cannot say. */
export const TIMEZONES: string[] = (() => {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.("timeZone") ?? [];
    return zones.length > 0 ? zones : FALLBACK_TIMEZONES;
  } catch {
    return FALLBACK_TIMEZONES;
  }
})();

/** What this browser reports, offered as a one-tap setting. */
export function deviceLocale(): { locale: string; timezone: string } | null {
  try {
    const locale = navigator.language;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return /^[a-z]{2,3}(-[A-Z]{2})?$/.test(locale) && timezone ? { locale, timezone } : null;
  } catch {
    return null;
  }
}
