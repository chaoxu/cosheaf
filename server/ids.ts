import { randomBytes } from "node:crypto";

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateDocId(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    out += ID_ALPHABET.charAt(byte % ID_ALPHABET.length);
  }
  return out;
}
