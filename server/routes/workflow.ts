import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppEnv } from "../types.js";
import { workspaceDir } from "../db.js";
import { requireAuth, requireMembership } from "../middleware.js";
import {
  WorkflowError,
  createProposal,
  decideOnDocument,
  getApprovalsForDocument,
  getDocument,
  getMinApprovals,
  getReviewQueue,
  setMinApprovals,
  submitDocument,
} from "../workflow.js";

export const workflow = new Hono<AppEnv>();

workflow.use("*", requireAuth);
workflow.use("/:slug/*", requireMembership());

function workflowError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof WorkflowError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  throw err;
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
    return workflowError(c, err);
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
  const root = workspaceDir(c.get("config"), ws.slug);
  try {
    const r = await createProposal(c.get("db"), ws.id, root, body.target_id, body.body, c.get("user").username);
    return c.json({ path: r.proposalPath, meta: r.meta }, 201);
  } catch (err) {
    return workflowError(c, err);
  }
});

workflow.post("/:slug/document/:id/submit", async (c) => {
  const ws = c.get("workspace");
  const root = workspaceDir(c.get("config"), ws.slug);
  try {
    return c.json(await submitDocument(c.get("db"), ws.id, root, c.req.param("id") ?? ""));
  } catch (err) {
    return workflowError(c, err);
  }
});

async function decide(c: Context<AppEnv>, decision: "approve" | "reject"): Promise<Response> {
  const ws = c.get("workspace");
  if (ws.role !== "owner" && ws.role !== "verifier") {
    return c.json({ error: "verifier role required" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { comment?: string } | null;
  const comment =
    typeof body?.comment === "string" && body.comment.trim().length > 0
      ? body.comment.trim()
      : null;
  const root = workspaceDir(c.get("config"), ws.slug);
  try {
    const r = await decideOnDocument(
      c.get("db"),
      ws.id,
      root,
      c.req.param("id") ?? "",
      c.get("user").id,
      decision,
      comment,
    );
    return c.json(r);
  } catch (err) {
    return workflowError(c, err);
  }
}

workflow.post("/:slug/document/:id/approve", (c) => decide(c, "approve"));
workflow.post("/:slug/document/:id/reject", (c) => decide(c, "reject"));

workflow.get("/:slug/document/:id/approvals", (c) => {
  const ws = c.get("workspace");
  return c.json({
    approvals: getApprovalsForDocument(c.get("db"), ws.id, c.req.param("id") ?? ""),
  });
});

workflow.get("/:slug/proposal/:id/target", async (c) => {
  const ws = c.get("workspace");
  const db = c.get("db");
  try {
    const proposal = getDocument(db, ws.id, c.req.param("id") ?? "");
    if (proposal.type !== "proposal" || !proposal.target_id) {
      return c.json({ error: "not a proposal with a target" }, 400);
    }
    const target = getDocument(db, ws.id, proposal.target_id);
    const full = path.join(workspaceDir(c.get("config"), ws.slug), target.path);
    const content = await fs.readFile(full, "utf8").catch(() => "");
    return c.json({
      target_id: target.id,
      target_path: target.path,
      target_title: target.title,
      target_content: content,
    });
  } catch (err) {
    return workflowError(c, err);
  }
});
