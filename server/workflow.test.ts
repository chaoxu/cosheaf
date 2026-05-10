import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAtomic } from "./atomic.js";
import { parseDocument } from "./frontmatter.js";
import { indexDocument } from "./indexer.js";
import {
  WorkflowError,
  createProposal,
  createReview,
  decideOnDocument,
  getApprovalsForDocument,
  getDocument,
  getReviewQueue,
  setMinApprovals,
  submitDocument,
} from "./workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(path.join(__dirname, "schema.sql"), "utf8");

interface Ctx {
  db: Database.Database;
  root: string;
  workspaceId: number;
  alice: number; // verifier 1
  bob: number; // verifier 2
}

function makeCtx(): Ctx {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  const root = mkdtempSync(path.join(tmpdir(), "cosheaf-workflow-"));
  const ws = db
    .prepare(
      "INSERT INTO workspaces (slug, name, created_at) VALUES ('t', 'T', ?) RETURNING id",
    )
    .get(Date.now()) as { id: number };
  const alice = (db
    .prepare(
      "INSERT INTO users (username, password_hash, created_at) VALUES ('alice', '', ?) RETURNING id",
    )
    .get(Date.now()) as { id: number }).id;
  const bob = (db
    .prepare(
      "INSERT INTO users (username, password_hash, created_at) VALUES ('bob', '', ?) RETURNING id",
    )
    .get(Date.now()) as { id: number }).id;
  db.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'verifier')").run(
    ws.id,
    alice,
  );
  db.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'verifier')").run(
    ws.id,
    bob,
  );
  return { db, root, workspaceId: ws.id, alice, bob };
}

async function makeDraft(ctx: Ctx, relPath: string, body: string): Promise<string> {
  const content = `---\nstatus: draft\n---\n${body}`;
  const indexed = indexDocument(ctx.db, ctx.workspaceId, relPath, content);
  await writeAtomic(ctx.workspaceId, ctx.root, relPath, indexed.content);
  return indexed.meta.id;
}

function readStatus(ctx: Ctx, relPath: string): string {
  const txt = readFileSync(path.join(ctx.root, relPath), "utf8");
  return String(parseDocument(txt).frontmatter.status);
}

let ctx: Ctx;

beforeEach(() => {
  ctx = makeCtx();
});

afterEach(() => {
  ctx.db.close();
  rmSync(ctx.root, { recursive: true, force: true });
});

describe("submitDocument", () => {
  it("looks up one document by id", async () => {
    const id = await makeDraft(ctx, "page.md", "# Hello\n");
    const doc = getDocument(ctx.db, ctx.workspaceId, id);
    expect(doc.path).toBe("page.md");
    expect(doc.status).toBe("draft");
  });

  it("moves draft → unreviewed and rewrites frontmatter", async () => {
    const id = await makeDraft(ctx, "page.md", "# Hello\n");
    const r = await submitDocument(ctx.db, ctx.workspaceId, ctx.root, id);
    expect(r.status).toBe("unreviewed");
    expect(readStatus(ctx, "page.md")).toBe("unreviewed");
  });

  it("refuses to submit a non-draft", async () => {
    const id = await makeDraft(ctx, "page.md", "# Hello\n");
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, id);
    await expect(submitDocument(ctx.db, ctx.workspaceId, ctx.root, id)).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });
});

describe("decideOnDocument (page)", () => {
  it("approves below threshold stays unreviewed", async () => {
    setMinApprovals(ctx.db, ctx.workspaceId, 2);
    const id = await makeDraft(ctx, "page.md", "# T\n");
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, id);
    const r = await decideOnDocument(ctx.db, ctx.workspaceId, ctx.root, id, ctx.alice, "approve");
    expect(r.doc_status).toBe("unreviewed");
    expect(r.approvals).toBe(1);
    expect(readStatus(ctx, "page.md")).toBe("unreviewed");
  });

  it("approve at threshold promotes to golden", async () => {
    setMinApprovals(ctx.db, ctx.workspaceId, 2);
    const id = await makeDraft(ctx, "page.md", "# T\n");
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, id);
    await decideOnDocument(ctx.db, ctx.workspaceId, ctx.root, id, ctx.alice, "approve");
    const r = await decideOnDocument(ctx.db, ctx.workspaceId, ctx.root, id, ctx.bob, "approve");
    expect(r.doc_status).toBe("golden");
    expect(readStatus(ctx, "page.md")).toBe("golden");
  });

  it("reject moves to rejected even with prior approve", async () => {
    setMinApprovals(ctx.db, ctx.workspaceId, 2);
    const id = await makeDraft(ctx, "page.md", "# T\n");
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, id);
    await decideOnDocument(ctx.db, ctx.workspaceId, ctx.root, id, ctx.alice, "approve");
    const r = await decideOnDocument(ctx.db, ctx.workspaceId, ctx.root, id, ctx.bob, "reject");
    expect(r.doc_status).toBe("rejected");
    expect(readStatus(ctx, "page.md")).toBe("rejected");
  });

  it("stores reviewer comments", async () => {
    const id = await makeDraft(ctx, "page.md", "# T\n");
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, id);
    await decideOnDocument(
      ctx.db,
      ctx.workspaceId,
      ctx.root,
      id,
      ctx.alice,
      "approve",
      "lgtm",
    );
    const row = ctx.db
      .prepare("SELECT comment FROM approvals WHERE document_id = ?")
      .get(id) as { comment: string | null };
    expect(row.comment).toBe("lgtm");
  });
});

describe("createProposal + promote", () => {
  it("approving a proposal at threshold rewrites the target body and archives the proposal", async () => {
    setMinApprovals(ctx.db, ctx.workspaceId, 1);
    const targetId = await makeDraft(ctx, "page.md", "# Old\n\nOld body.\n");
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, targetId);
    await decideOnDocument(ctx.db, ctx.workspaceId, ctx.root, targetId, ctx.alice, "approve");
    expect(readStatus(ctx, "page.md")).toBe("golden");

    const { proposalPath, meta } = await createProposal(
      ctx.db,
      ctx.workspaceId,
      ctx.root,
      targetId,
      "# New\n\nNew body.\n",
      "alice",
    );
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, meta.id);
    const r = await decideOnDocument(
      ctx.db,
      ctx.workspaceId,
      ctx.root,
      meta.id,
      ctx.bob,
      "approve",
    );
    expect(r.doc_status).toBe("archived");
    expect(readStatus(ctx, proposalPath)).toBe("archived");
    const targetText = readFileSync(path.join(ctx.root, "page.md"), "utf8");
    const parsed = parseDocument(targetText);
    expect(parsed.frontmatter.status).toBe("golden");
    expect(parsed.body).toContain("New body.");
    expect(parsed.body).not.toContain("Old body.");
  });
});

describe("createReview + attach to approval", () => {
  it("links review_doc_id on the approval row and surfaces it via getApprovalsForDocument", async () => {
    const id = await makeDraft(ctx, "page.md", "# T\n");
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, id);
    const review = await createReview(
      ctx.db,
      ctx.workspaceId,
      ctx.root,
      id,
      "## Verdict\nLooks correct because…",
      "alice",
    );
    expect(review.meta.type).toBe("review");
    await decideOnDocument(
      ctx.db,
      ctx.workspaceId,
      ctx.root,
      id,
      ctx.alice,
      "approve",
      null,
      review.meta.id,
    );
    const rows = getApprovalsForDocument(ctx.db, ctx.workspaceId, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].review_doc_id).toBe(review.meta.id);
    expect(rows[0].review_path).toBe(review.reviewPath);
    expect(rows[0].review_title).toBe("Review of T");
  });

  it("rejects a review_doc_id whose target doesn't match", async () => {
    const a = await makeDraft(ctx, "a.md", "# A\n");
    const b = await makeDraft(ctx, "b.md", "# B\n");
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, a);
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, b);
    const wrongReview = await createReview(
      ctx.db,
      ctx.workspaceId,
      ctx.root,
      b,
      "x",
      "alice",
    );
    await expect(
      decideOnDocument(
        ctx.db,
        ctx.workspaceId,
        ctx.root,
        a,
        ctx.alice,
        "approve",
        null,
        wrongReview.meta.id,
      ),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe("getReviewQueue", () => {
  it("returns only unreviewed documents", async () => {
    const a = await makeDraft(ctx, "a.md", "# A\n");
    const b = await makeDraft(ctx, "b.md", "# B\n");
    await submitDocument(ctx.db, ctx.workspaceId, ctx.root, a);
    const queue = getReviewQueue(ctx.db, ctx.workspaceId);
    expect(queue.map((q) => q.id)).toEqual([a]);
    expect(queue.find((q) => q.id === b)).toBeUndefined();
  });
});
