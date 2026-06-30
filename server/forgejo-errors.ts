import { ForgejoError } from "./forgejo.js";

// Predicate for the most common collaboration error guard: a 404 (repo / branch
// / issue / pull not found) from whatever client the route is reading through.
// Status-bearing rather than forge-specific so it covers BOTH the co-located
// forge (hosted: ForgejoError) and the bound remote core (local Workbench:
// RemoteCosheafError) — both carry a numeric `status`. This is the shared 404
// predicate the collaboration seam needs (#262/#268) so the same route handles
// not-found identically in both modes.
export function is404(err: unknown): boolean {
  if (err instanceof ForgejoError) return err.status === 404;
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 404
  );
}

// `.catch` handler that swallows a Forgejo 404 into `fallback` and rethrows
// everything else (so the global error handler still owns real failures). Use
// for the mechanical `.catch(err => { if (is404(err)) return X; throw err })`
// sites: `fj.getIssue(...).catch(onForgejo404(null))`.
export function onForgejo404<T>(fallback: T): (err: unknown) => T {
  return (err: unknown) => {
    if (is404(err)) return fallback;
    throw err;
  };
}
