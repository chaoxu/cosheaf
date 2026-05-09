import { promises as fs } from "node:fs";
import path from "node:path";
import { markSelfWrite } from "./watcher.js";

/** Write `content` to `<workspaceRoot>/<filePath>` via tmp + rename, then mark the
 * write as self-originated so the FS watcher doesn't echo it back. */
export async function writeAtomic(
  workspaceId: number,
  workspaceRoot: string,
  filePath: string,
  content: string,
): Promise<void> {
  const full = path.join(workspaceRoot, filePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, full);
  markSelfWrite(workspaceId, filePath);
}
