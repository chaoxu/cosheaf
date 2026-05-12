import type { LineComment, PullFile } from "../api";

export type SpikeId = "unified" | "tint" | "split" | "rendered";

export interface SpikeProps {
  file: PullFile;
  loadContent: (side: "base" | "head") => Promise<string>;
  comments: readonly LineComment[];
}
