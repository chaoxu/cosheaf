import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../types.js";
import { workspaceDir } from "../db.js";
import { requireAuth, requireMembership } from "../middleware.js";
import {
  WorkflowError,
  createProposal,
  decideOnDocument,
  getMinApprovals,
  getReviewQueue,
  setMinApprovals,
  submitDocument,
} from "../workflow.js";

export const workflow = new Hono<AppEnv>();

workflow.use("*", requireAuth);
workflow.use("/:slug/*", requireMembership());

function handleError<T>(promise: Promise<T>): Promise<T | { __error: WorkflowError }> {
  return promise.catch((err) => {
    if (err instanceof WorkflowError) return { __error: err };
    throw err;
  });
}

workflow.get("/:slug/queue", (c) => {
  const ws = c.get("workspace");
  return c.json({ queue: getReviewQueue(c.get("db"), ws.id) });
});

workflow.get("/:slug/settings", (c) => {
  const ws = c.get("workspace");
  return c.json({ min_approvals: getMinApprovals(c.get("db"), ws.id) });
});

workflow.put("/:slug/settings", async (c) => {
  if (c.get("workspace").role !== "owner") return c.json({ error: "owner only" }, 403);
  const body = (await c.req.json().catch(() => null)) as { min_approvals?: number } | null;
  if (!body || body.min_approvals == null) return c.json({ error: "min_approvals required" }, 400);
  try {
    setMinApprovals(c.get("db"), c.get("workspace").id, body.min_approvals);
  } catch (err) {
    if (err instanceof WorkflowError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    throw err;
  }
  return c.json({ min_approvals: body.min_approvals });
});

workflow.post("/:slug/proposal", async (c) => {
  const ws = c.get("workspace");
  const body = (await c.req.json().catch(() => null)) as
    | { target_id?: string; body?: string }
    | null;
  if (!body?.target_id || body.body == null) {
    return c.json({ error: "target_id and body required" }, 400);
  }
  const config = c.get("config");
  const root = workspaceDir(config, ws.slug);
  const result = await handleError(
    createProposal(c.get("db"), ws.id, root, body.target_id, body.body, c.get("user").username),
  );
  if ("__error" in result) return c.json({ error: result.__error.message }, result.__error.status as ContentfulStatusCode);
  return c.json({ path: result.proposalPath, meta: result.meta }, 201);
});

workflow.post("/:slug/document/:id/submit", async (c) => {
  const ws = c.get("workspace");
  const config = c.get("config");
  const root = workspaceDir(config, ws.slug);
  const id = c.req.param("id");
  const result = await handleError(submitDocument(c.get("db"), ws.id, root, id));
  if ("__error" in result) return c.json({ error: result.__error.message }, result.__error.status as ContentfulStatusCode);
  return c.json(result);
});

async function decide(
  c: Context<AppEnv>,
  decision: "approve" | "reject",
) {
  const ws = c.get("workspace");
  if (ws.role !== "owner" && ws.role !== "verifier") {
    return c.json({ error: "verifier role required" }, 403);
  }
  const config = c.get("config");
  const root = workspaceDir(config, ws.slug);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id required" }, 400);
  const user = c.get("user");
  const result = await handleError(
    decideOnDocument(c.get("db"), ws.id, root, id, user.id, decision),
  );
  if ("__error" in result) return c.json({ error: result.__error.message }, result.__error.status as ContentfulStatusCode);
  return c.json(result);
}

workflow.post("/:slug/document/:id/approve", (c) => decide(c, "approve"));
workflow.post("/:slug/document/:id/reject", (c) => decide(c, "reject"));
