const NOT_DIGITS = /\D/g;
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/**
 * A number as people write it ("07700 900123", "+44 (0)7700 900123", "0044...") in E.164, or null
 * when it cannot be one. Numbers without a country code get the user's default.
 */
export function normalisePhone(raw: string, countryCode = "+44"): string | null {
  const trimmed = raw.trim();
  const code = countryCode.replace(NOT_DIGITS, "");
  let digits = trimmed.replace(NOT_DIGITS, "");
  let result: string;
  if (trimmed.startsWith("+")) {
    // "+44 (0)7700" carries the national trunk zero that the international form drops
    if (digits.startsWith(`${code}0`)) {
      digits = code + digits.slice(code.length + 1);
    }
    result = `+${digits}`;
  } else if (digits.startsWith("00")) {
    result = `+${digits.slice(2)}`;
  } else if (digits.startsWith("0")) {
    result = `+${code}${digits.slice(1)}`;
  } else if (digits.startsWith(code) && digits.length >= 10) {
    result = `+${digits}`;
  } else {
    result = `+${code}${digits}`;
  }
  const length = result.length - 1;
  return length >= MIN_DIGITS && length <= MAX_DIGITS ? result : null;
}

/** Lower case, no accents, no punctuation: what name lookups compare against. */
export const searchName = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Twilio addresses WhatsApp users as whatsapp:+E164; the phone book keeps the bare number. */
export const WHATSAPP_PREFIX = "whatsapp:";
export const toWhatsapp = (phone: string) => (phone.startsWith(WHATSAPP_PREFIX) ? phone : `${WHATSAPP_PREFIX}${phone}`);
export const bareNumber = (address: string) =>
  address.startsWith(WHATSAPP_PREFIX) ? address.slice(WHATSAPP_PREFIX.length) : address;
