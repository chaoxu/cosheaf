import type { Side } from "./diff-position.js";
import type { ForgejoPull } from "./forgejo-types.js";

export interface PrSideFile {
  path: string;
  previous_path?: string;
}

export function prSideRefAndPath(pull: ForgejoPull, file: PrSideFile, side: Side): { ref: string; path: string } {
  return side === "base"
    ? { ref: pull.base.sha, path: file.previous_path ?? file.path }
    : { ref: pull.head.sha, path: file.path };
}
