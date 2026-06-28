import type { Context } from "hono";
import type { AppEnv } from "../types.js";

export function wantsTeaShape(c: Context<AppEnv>): boolean {
  return c.req.header("authorization")?.trimStart().toLowerCase().startsWith("token ") ?? false;
}

export function scrubBackendUrls(c: Context<AppEnv>, value: unknown): unknown {
  const backendOrigin = new URL(c.get("config").forgejoUrl).origin;
  const publicOrigin = new URL(c.req.url).origin;
  return scrubValue(value, backendOrigin, publicOrigin);
}

function scrubValue(value: unknown, backendOrigin: string, publicOrigin: string): unknown {
  if (typeof value === "string") return value.split(backendOrigin).join(publicOrigin);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, backendOrigin, publicOrigin));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = scrubValue(item, backendOrigin, publicOrigin);
  }
  return out;
}
