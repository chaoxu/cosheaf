import { useEffect, useState } from "react";

interface State {
  content: string | null;
  error: string | null;
}

// Loads one side of a file (base or head) lazily. `enabled=false` short-circuits
// to a synthetic empty string — used when a status is "added" (no base) or
// "deleted" (no head), so the caller doesn't need a separate branch.
export function useFileSide(
  load: (side: "base" | "head") => Promise<string>,
  side: "base" | "head",
  enabled: boolean,
  resetKey: string,
): State {
  const [state, setState] = useState<State>({ content: enabled ? null : "", error: null });

  useEffect(() => {
    if (!enabled) {
      setState({ content: "", error: null });
      return;
    }
    let cancelled = false;
    setState({ content: null, error: null });
    load(side)
      .then((content) => {
        if (!cancelled) setState({ content, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ content: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [resetKey, side, enabled, load]);

  return state;
}
