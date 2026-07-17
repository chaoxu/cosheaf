import { createHash } from "node:crypto";

// git blob hash: sha1("blob " + bytelength + "\0" + bytes). Equals
// `git hash-object` for the same content.
export function gitBlobHash(bytes: Buffer): string {
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}
