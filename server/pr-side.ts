import type { Side } from "./diff-position.js";
import type { PrMeta } from "../shared/review.js";

export interface PrSideFile {
  path: string;
  previous_path?: string;
}

export function prSideRefAndPath(pull: PrMeta, file: PrSideFile, side: Side): { ref: string; path: string } {
  return side === "base"
    ? { ref: pull.base_sha, path: file.previous_path ?? file.path }
    : { ref: pull.head_sha, path: file.path };
}
