// AES-256-GCM encryption for stored Forgejo PATs.
//
// Key derivation: scrypt(SESSION_SECRET, salt). SESSION_SECRET is already a
// required env var; we reuse it rather than introduce a second secret to
// manage. The salt is a fixed namespace string — the threat we're hardening
// against is DB exfiltration (someone reading db.sqlite without server
// access), not key compromise. If SESSION_SECRET leaks, sessions are forged
// anyway, so binding PAT encryption to it is the right strength.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALG = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;   // GCM standard
const TAG_LEN = 16;
const SALT = Buffer.from("cosheaf-pat-key:v1");

let cachedKey: { secret: string; key: Buffer } | null = null;
function deriveKey(secret: string): Buffer {
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  const key = scryptSync(secret, SALT, KEY_LEN);
  cachedKey = { secret, key };
  return key;
}

export function encryptPat(plaintext: string, sessionSecret: string): Buffer {
  const key = deriveKey(sessionSecret);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: iv || tag || ciphertext. Authenticated, so any tamper fails decrypt.
  return Buffer.concat([iv, tag, enc]);
}

export function decryptPat(blob: Buffer, sessionSecret: string): string {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("encrypted blob too short");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  const key = deriveKey(sessionSecret);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}
