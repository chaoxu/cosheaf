import { ForgejoError } from "./forgejo.js";

// Predicate for the most common collaboration error guard: a 404 (repo / branch
// / issue / pull not found) from whatever client the route is reading through.
// Status-bearing rather than forge-specific so it covers BOTH the co-located
// forge (hosted: ForgejoError) and the bound remote core (local Workbench:
// RemoteCosheafError) — both carry a numeric `status`. This is the shared 404
// predicate the collaboration seam needs (#262/#268) so the same route handles
// not-found identically in both modes.
export function is404(err: unknown): boolean {
  return isStatus(err, 404);
}

// The numeric HTTP status of any status-bearing error, or null. Covers BOTH the
// co-located forge (ForgejoError) and the bound remote core (RemoteCosheafError)
// — both carry a numeric `status` — so collaboration routes classify write
// conflicts identically in hosted and local Workbench modes.
export function errorStatus(err: unknown): number | null {
  if (err instanceof ForgejoError) return err.status;
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return null;
}

// True when the error carries exactly `status`.
export function isStatus(err: unknown, status: number): boolean {
  return errorStatus(err) === status;
}

// True when the error carries any of the given statuses (e.g. the
// duplicate-PR/empty-diff 409|422 recovery on POST /pulls).
export function is4xx(err: unknown, ...statuses: number[]): boolean {
  const s = errorStatus(err);
  return s !== null && statuses.includes(s);
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
