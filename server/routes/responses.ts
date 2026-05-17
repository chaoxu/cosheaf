// Typed error envelope helpers shared by every route. The shape is what
// agents and the SPA both consume; pinning it here means a new route
// doesn't reinvent the spelling (`code: "Conflict"` vs `code: "conflict"`).
//
// Each helper returns a tuple `[body, status]` you spread into `c.json`:
//
//   return c.json(...bad("title required"));
//   return c.json(...notFound("workspace not found"));
//   return c.json(...forbidden("admin required"));
//
// For codes that need extra structured context (e.g. PUT /settings's
// `step: "reindex"`), pass `details`.

// Closed string-literal union so a typo in a route's `code` field bites
// the compiler. Document this in API.md too.
export type ErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "unauthorized"
  | "conflict"
  | "method_not_allowed"
  | "bad_gateway"
  | "pat_invalid"
  | "forgejo_failed"
  | "reindex_failed";

export interface ErrorBody {
  error: string;
  code: ErrorCode;
  details?: Record<string, unknown>;
}

type ErrorTuple<S extends number> = readonly [ErrorBody, S];

function envelope<C extends ErrorCode, S extends number>(
  code: C,
  status: S,
  msg: string,
  details?: Record<string, unknown>,
): ErrorTuple<S> {
  return [{ error: msg, code, ...(details ? { details } : {}) }, status] as const;
}

export const bad = (msg: string, details?: Record<string, unknown>) =>
  envelope("validation", 400, msg, details);

export const unauthorized = (msg = "not authenticated") =>
  envelope("unauthorized", 401, msg);

export const forbidden = (msg: string) => envelope("forbidden", 403, msg);

export const notFound = (msg = "not found") => envelope("not_found", 404, msg);

export const methodNotAllowed = (msg = "method not allowed for this path") =>
  envelope("method_not_allowed", 405, msg);

export const conflict = (msg: string) => envelope("conflict", 409, msg);

export const badGateway = (msg: string, details?: Record<string, unknown>) =>
  envelope("bad_gateway", 502, msg, details);
