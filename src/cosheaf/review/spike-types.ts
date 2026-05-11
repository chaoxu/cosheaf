import type { PullFile } from "../api";

export type SpikeId = "unified" | "tint" | "split" | "rendered";

export interface SpikeProps {
  file: PullFile;
  loadContent: (side: "base" | "head") => Promise<string>;
}
