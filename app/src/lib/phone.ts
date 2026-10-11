const NOT_DIGITS = /\D/g;

/** The same rules as the server's normalisePhone, so a field shows what will be stored before saving. */
export function toE164(raw: string, countryCode = "+44"): string | null {
  const trimmed = raw.trim();
  const code = countryCode.replace(NOT_DIGITS, "");
  let digits = trimmed.replace(NOT_DIGITS, "");
  let result: string;
  if (trimmed.startsWith("+")) {
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
  return length >= 8 && length <= 15 ? result : null;
}
