export interface Locale {
  /** BCP 47 language and region, such as en-GB. */
  locale: string;
  /** IANA time zone, such as Europe/London. */
  timezone: string;
}

export const DEFAULT_LOCALE: Locale = { locale: "en-GB", timezone: "Europe/London" };

export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;

const CURRENCIES: Record<string, string> = {
  GB: "GBP",
  US: "USD",
  CA: "CAD",
  AU: "AUD",
  NZ: "NZD",
  IE: "EUR",
  DE: "EUR",
  FR: "EUR",
  ES: "EUR",
  IT: "EUR",
  NL: "EUR",
  BE: "EUR",
  AT: "EUR",
  PT: "EUR",
  FI: "EUR",
  GR: "EUR",
  CH: "CHF",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  PL: "PLN",
  CZ: "CZK",
  HU: "HUF",
  RO: "RON",
  BG: "BGN",
  UA: "UAH",
  TR: "TRY",
  IN: "INR",
  JP: "JPY",
  CN: "CNY",
  KR: "KRW",
  SG: "SGD",
  HK: "HKD",
  BR: "BRL",
  MX: "MXN",
  ZA: "ZAR",
  AE: "AED",
  IL: "ILS",
};

export function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const regionOf = (locale: string) => locale.split("-")[1] ?? "";

export const currencyOf = (locale: string): string | null => CURRENCIES[regionOf(locale)] ?? null;

function nameOf(kind: "language" | "region" | "currency", code: string): string {
  try {
    return new Intl.DisplayNames("en", { type: kind }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The opening line of every session: the date and clock where the user is, and the conventions
 * their locale implies, shown as examples so the model copies them rather than guessing.
 */
export function localeInstructions({ locale, timezone }: Locale, now: Date): string {
  const tz = validTimezone(timezone) ? timezone : DEFAULT_LOCALE.timezone;
  const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const weekday = new Intl.DateTimeFormat("en", { timeZone: tz, weekday: "long" }).format(now);
  const language = nameOf("language", locale.split("-")[0] ?? locale);
  const region = regionOf(locale);
  const currency = currencyOf(locale);
  const sampleDate = safeFormat(() =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, day: "numeric", month: "numeric", year: "numeric" }).format(now),
  );
  const sampleTime = safeFormat(() =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now),
  );
  const sampleMoney = currency
    ? safeFormat(() => new Intl.NumberFormat(locale, { style: "currency", currency }).format(1234.5))
    : "";
  const conventions = [
    `speak ${language}${region ? ` as spoken in ${nameOf("region", region)}` : ""}`,
    currency ? `money is ${nameOf("currency", currency)} (${currency}), written like ${sampleMoney}` : "",
    sampleDate ? `dates are written like ${sampleDate}` : "",
    sampleTime ? `times like ${sampleTime}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return (
    `Today is ${isoDate} (${weekday}), ${clock} in ${tz}: that is the user's current date and time, use it for ` +
    `anything about the time, the date or what day it is. The user's locale is ${locale}: ${conventions}.`
  );
}

function safeFormat(format: () => string): string {
  try {
    return format();
  } catch {
    return "";
  }
}
