import { ForgejoError } from "./forgejo.js";

// Predicate for the most common Forgejo error guard: a 404 from the upstream
// API (repo/branch/issue/pull not found). Replaces the repeated
// `err instanceof ForgejoError && err.status === 404` boilerplate at sites that
// branch on a missing resource.
export function is404(err: unknown): boolean {
  return err instanceof ForgejoError && err.status === 404;
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
