import { fromBase64Url, fromHex, toBase64Url } from "./crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Provider credentials sit in D1 only as AES-256-GCM ciphertext under the SECRETS_KEY Worker secret. */
export async function seal(keyHex: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyHex);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(value)));
  return `v1:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function open<T>(keyHex: string, sealed: string): Promise<T> {
  const [version, iv, ciphertext] = sealed.split(":");
  if (version !== "v1" || !iv || !ciphertext) {
    throw new Error("unknown secret format");
  }
  const key = await importKey(keyHex);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, key, fromBase64Url(ciphertext));
  return JSON.parse(decoder.decode(plain)) as T;
}

function importKey(keyHex: string): Promise<CryptoKey> {
  const bytes = fromHex(keyHex);
  if (bytes.byteLength !== 32) {
    throw new Error("SECRETS_KEY must be 32 bytes as hex");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
