// Prints the PBKDF2 hash the API stores, so `just add-user` can insert users straight into D1.
import { pbkdf2Sync, randomBytes } from "node:crypto";

const ITERATIONS = 100_000;
const password = process.argv[2];
if (!password) {
  console.error("usage: hash-password.mjs <password>");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
const base64url = (bytes) => bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
console.log(["pbkdf2", ITERATIONS, base64url(salt), base64url(hash)].join("$"));
