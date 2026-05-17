// Thin wrapper around the Forgejo REST API.
//
// Each instance is bound to a single token. On the request path that's the
// authenticated user's PAT (stored encrypted in users.forgejo_token_ciphertext);
// for out-of-band provisioning (CLI user/workspace creation, webhook handler)
// we instantiate a separate admin-bound instance. There is no impersonation header
// — Forgejo attributes every action to whoever owns the token.

import type {
  ForgejoActivity,
  ForgejoBranch,
  ForgejoBranchProtection,
  ForgejoContent,
  ForgejoFileResponse,
  ForgejoHook,
  ForgejoIssue,
  ForgejoNotificationThread,
  ForgejoPull,
  ForgejoPullFile,
  ForgejoPullReviewComment,
  ForgejoRepo,
  ForgejoReview,
  ForgejoTimelineEvent,
  ForgejoTreeEntry,
  ForgejoUser,
} from "./forgejo-types.js";

export interface ForgejoConfig {
  baseUrl: string;
  token: string;  // PAT for the identity this client acts as
}

export class ForgejoError extends Error {
  constructor(
    public status: number,
    public bodyText: string,
    public method: string,
    public path: string,
  ) {
    super(`forgejo ${method} ${path} -> ${status}: ${bodyText.slice(0, 300)}`);
  }
}

interface RequestOpts {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  raw?: boolean;
  expectEmpty?: boolean;
}

export class Forgejo {
  constructor(private cfg: ForgejoConfig) {}

  private async req<T = unknown>(p: string, opts: RequestOpts = {}): Promise<T> {
    const url = new URL(p.startsWith("/") ? this.cfg.baseUrl + p : p);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      authorization: `token ${this.cfg.token}`,
      accept: "application/json",
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      throw new ForgejoError(res.status, await res.text(), opts.method ?? "GET", p);
    }
    if (opts.raw) return (await res.text()) as unknown as T;
    if (opts.expectEmpty || res.status === 204) return undefined as T;
    const txt = await res.text();
    return (txt ? JSON.parse(txt) : undefined) as T;
  }

  // ---------------- users ----------------

  async getCurrentUser(): Promise<ForgejoUser> {
    return this.req<ForgejoUser>("/api/v1/user");
  }

  async getUserByName(username: string): Promise<ForgejoUser | null> {
    try {
      return await this.req<ForgejoUser>(`/api/v1/users/${encodeURIComponent(username)}`);
    } catch (e) {
      if (e instanceof ForgejoError && e.status === 404) return null;
      throw e;
    }
  }

  async createUser(opts: {
    username: string;
    email: string;
    password: string;
    must_change_password?: boolean;
  }): Promise<ForgejoUser> {
    return this.req<ForgejoUser>("/api/v1/admin/users", {
      method: "POST",
      body: {
        username: opts.username,
        email: opts.email,
        password: opts.password,
        must_change_password: opts.must_change_password ?? false,
        send_notify: false,
        source_id: 0,
        login_name: opts.username,
      },
    });
  }

  async setUserActive(username: string, active: boolean): Promise<void> {
    await this.req(`/api/v1/admin/users/${encodeURIComponent(username)}`, {
      method: "PATCH",
      body: { active },
      expectEmpty: true,
    });
  }

  // ---------------- repos ----------------

  async createUserRepo(opts: {
    name: string;
    description?: string;
    private?: boolean;
    auto_init?: boolean;
    default_branch?: string;
  }): Promise<ForgejoRepo> {
    return this.req<ForgejoRepo>("/api/v1/user/repos", {
      method: "POST",
      body: {
        name: opts.name,
        description: opts.description ?? "",
        private: opts.private ?? true,
        auto_init: opts.auto_init ?? true,
        default_branch: opts.default_branch ?? "main",
      },
    });
  }

  async deleteRepo(owner: string, repo: string): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}`, { method: "DELETE", expectEmpty: true });
  }

  async getRepo(owner: string, repo: string): Promise<ForgejoRepo | null> {
    try {
      return await this.req<ForgejoRepo>(`/api/v1/repos/${owner}/${repo}`);
    } catch (e) {
      if (e instanceof ForgejoError && e.status === 404) return null;
      throw e;
    }
  }

  async addCollaborator(owner: string, repo: string, username: string, permission: "read" | "write" | "admin"): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}`, {
      method: "PUT",
      body: { permission },
      expectEmpty: true,
    });
  }

  async removeCollaborator(owner: string, repo: string, username: string): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}`, {
      method: "DELETE",
      expectEmpty: true,
    });
  }

  async listCollaborators(owner: string, repo: string): Promise<ForgejoUser[]> {
    return this.req<ForgejoUser[]>(`/api/v1/repos/${owner}/${repo}/collaborators`);
  }

  // Returns "admin"|"write"|"read"|"none". `owner` is collapsed to `admin` so
  // routes have one fewer level to gate on. 404 on the repo (or unknown user)
  // surfaces as "none" — the workspace middleware treats that as no access.
  async getRepoPermission(
    owner: string,
    repo: string,
    username: string,
  ): Promise<"admin" | "write" | "read" | "none"> {
    try {
      const r = await this.req<{ permission?: string }>(
        `/api/v1/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
      );
      const p = r.permission;
      if (p === "owner" || p === "admin") return "admin";
      if (p === "write") return "write";
      if (p === "read") return "read";
      return "none";
    } catch (e) {
      if (e instanceof ForgejoError && e.status === 404) return "none";
      throw e;
    }
  }

  // ---------------- branch protection ----------------

  async getBranchProtection(owner: string, repo: string, branch: string): Promise<ForgejoBranchProtection | null> {
    try {
      return await this.req<ForgejoBranchProtection>(`/api/v1/repos/${owner}/${repo}/branch_protections/${encodeURIComponent(branch)}`);
    } catch (e) {
      if (e instanceof ForgejoError && e.status === 404) return null;
      throw e;
    }
  }

  async createBranchProtection(owner: string, repo: string, opts: {
    branch_name: string;
    required_approvals?: number;
    push_whitelist_usernames?: string[];
  }): Promise<ForgejoBranchProtection> {
    const whitelist = opts.push_whitelist_usernames ?? [];
    return this.req<ForgejoBranchProtection>(`/api/v1/repos/${owner}/${repo}/branch_protections`, {
      method: "POST",
      body: {
        branch_name: opts.branch_name,
        required_approvals: opts.required_approvals ?? 1,
        enable_push: whitelist.length > 0,
        enable_push_whitelist: whitelist.length > 0,
        push_whitelist_usernames: whitelist,
        push_whitelist_deploy_keys: false,
        enable_approvals_whitelist: false,
        block_on_rejected_reviews: true,
        block_on_outdated_branch: false,
        dismiss_stale_approvals: false,
        enable_merge_whitelist: false,
        enable_status_check: false,
        apply_to_admins: false,
      },
    });
  }

  async patchBranchProtectionPushWhitelist(owner: string, repo: string, branch: string, usernames: string[]): Promise<ForgejoBranchProtection> {
    return this.req<ForgejoBranchProtection>(`/api/v1/repos/${owner}/${repo}/branch_protections/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: {
        enable_push: usernames.length > 0,
        enable_push_whitelist: usernames.length > 0,
        push_whitelist_usernames: usernames,
      },
    });
  }

  async updateBranchProtection(owner: string, repo: string, branch: string, patch: {
    required_approvals?: number;
  }): Promise<ForgejoBranchProtection> {
    return this.req<ForgejoBranchProtection>(`/api/v1/repos/${owner}/${repo}/branch_protections/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  // ---------------- webhooks ----------------

  async createRepoHook(owner: string, repo: string, url: string, secret: string, events: string[]): Promise<ForgejoHook> {
    return this.req<ForgejoHook>(`/api/v1/repos/${owner}/${repo}/hooks`, {
      method: "POST",
      body: {
        type: "forgejo",
        active: true,
        events,
        config: { url, content_type: "json", secret },
      },
    });
  }

  async listRepoHooks(owner: string, repo: string): Promise<ForgejoHook[]> {
    return this.req<ForgejoHook[]>(`/api/v1/repos/${owner}/${repo}/hooks`);
  }

  // ---------------- contents (files) ----------------

  async getRawFile(owner: string, repo: string, ref: string, filepath: string): Promise<string> {
    return this.req<string>(`/api/v1/repos/${owner}/${repo}/raw/${encodeFilePath(filepath)}`, {
      query: { ref },
      raw: true,
    });
  }

  async getFileMeta(owner: string, repo: string, ref: string, filepath: string): Promise<ForgejoContent | null> {
    try {
      return await this.req<ForgejoContent>(`/api/v1/repos/${owner}/${repo}/contents/${encodeFilePath(filepath)}`, {
        query: { ref },
      });
    } catch (e) {
      if (e instanceof ForgejoError && e.status === 404) return null;
      throw e;
    }
  }

  async putFile(owner: string, repo: string, opts: {
    branch: string;
    path: string;
    content: string; // raw text; will be base64-encoded
    sha?: string; // current sha if updating
    message: string;
  }): Promise<ForgejoFileResponse> {
    return this.putFileBytes(owner, repo, {
      ...opts,
      content: Buffer.from(opts.content, "utf8"),
    });
  }

  async putFileBytes(owner: string, repo: string, opts: {
    branch: string;
    path: string;
    content: Buffer; // raw bytes; will be base64-encoded
    sha?: string;
    message: string;
  }): Promise<ForgejoFileResponse> {
    const isUpdate = !!opts.sha;
    const body = {
      branch: opts.branch,
      content: opts.content.toString("base64"),
      message: opts.message,
      ...(isUpdate ? { sha: opts.sha } : {}),
    };
    const path = `/api/v1/repos/${owner}/${repo}/contents/${encodeFilePath(opts.path)}`;
    return this.req<ForgejoFileResponse>(path, {
      method: isUpdate ? "PUT" : "POST",
      body,
    });
  }

  async deleteFile(owner: string, repo: string, opts: {
    branch: string;
    path: string;
    sha: string;
    message: string;
  }): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/contents/${encodeFilePath(opts.path)}`, {
      method: "DELETE",
      body: { branch: opts.branch, sha: opts.sha, message: opts.message },
      expectEmpty: true,
    });
  }

  async getTree(owner: string, repo: string, ref: string, recursive = true): Promise<ForgejoTreeEntry[]> {
    const out: ForgejoTreeEntry[] = [];
    let page = 1;
    while (true) {
      const r = await this.req<{ tree: ForgejoTreeEntry[]; truncated: boolean }>(
        `/api/v1/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`,
        { query: { recursive: recursive ? "true" : "false", page, per_page: 50 } },
      );
      out.push(...(r.tree ?? []));
      if (!r.truncated || (r.tree ?? []).length === 0) break;
      page++;
      if (page > 50) break;
    }
    return out;
  }

  // ---------------- branches ----------------

  async createBranch(owner: string, repo: string, opts: { newBranchName: string; oldBranchName?: string }): Promise<ForgejoBranch> {
    return this.req<ForgejoBranch>(`/api/v1/repos/${owner}/${repo}/branches`, {
      method: "POST",
      body: {
        new_branch_name: opts.newBranchName,
        old_branch_name: opts.oldBranchName ?? "main",
      },
    });
  }

  async listBranches(owner: string, repo: string): Promise<ForgejoBranch[]> {
    const out: ForgejoBranch[] = [];
    let page = 1;
    while (true) {
      const batch = await this.req<ForgejoBranch[]>(
        `/api/v1/repos/${owner}/${repo}/branches`,
        { query: { page, per_page: 50 } },
      );
      if (batch.length === 0) break;
      out.push(...batch);
      if (batch.length < 50) break;
      page++;
      if (page > 50) break;
    }
    return out;
  }

  async getBranch(owner: string, repo: string, branch: string): Promise<ForgejoBranch | null> {
    try {
      return await this.req<ForgejoBranch>(`/api/v1/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    } catch (e) {
      if (e instanceof ForgejoError && e.status === 404) return null;
      throw e;
    }
  }

  async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`, {
      method: "DELETE",
      expectEmpty: true,
    });
  }

  // ---------------- pulls ----------------

  async createPull(owner: string, repo: string, opts: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<ForgejoPull> {
    return this.req<ForgejoPull>(`/api/v1/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      body: { head: opts.head, base: opts.base, title: opts.title, body: opts.body },
    });
  }

  async getPull(owner: string, repo: string, index: number): Promise<ForgejoPull | null> {
    try {
      return await this.req<ForgejoPull>(`/api/v1/repos/${owner}/${repo}/pulls/${index}`);
    } catch (e) {
      if (e instanceof ForgejoError && e.status === 404) return null;
      throw e;
    }
  }

  async listPulls(owner: string, repo: string, state: "open" | "closed" | "all"): Promise<ForgejoPull[]> {
    const out: ForgejoPull[] = [];
    let page = 1;
    while (true) {
      const r = await this.req<ForgejoPull[]>(`/api/v1/repos/${owner}/${repo}/pulls`, {
        query: { state, page, limit: 50, sort: "newest" },
      });
      if (!r || r.length === 0) break;
      out.push(...r);
      if (r.length < 50) break;
      page++;
      if (page > 20) break;
    }
    return out;
  }

  async editPull(owner: string, repo: string, index: number, patch: { title?: string; body?: string; state?: "open" | "closed" }): Promise<ForgejoPull> {
    return this.req<ForgejoPull>(`/api/v1/repos/${owner}/${repo}/pulls/${index}`, {
      method: "PATCH",
      body: patch,
    });
  }

  async mergePull(owner: string, repo: string, index: number, opts: { Do: "merge" | "squash" | "rebase"; message?: string; force?: boolean }): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/pulls/${index}/merge`, {
      method: "POST",
      body: { Do: opts.Do, MergeMessageField: opts.message ?? "", force_merge: opts.force ?? false },
      expectEmpty: true,
    });
  }

  async listPullFiles(owner: string, repo: string, index: number): Promise<ForgejoPullFile[]> {
    return this.req<ForgejoPullFile[]>(`/api/v1/repos/${owner}/${repo}/pulls/${index}/files`);
  }

  async getPullDiff(owner: string, repo: string, index: number): Promise<string> {
    return this.req<string>(`/api/v1/repos/${owner}/${repo}/pulls/${index}.diff`, { raw: true });
  }

  async listReviews(owner: string, repo: string, index: number): Promise<ForgejoReview[]> {
    // Paginate. Forgejo's default page size is 50 but PRs with long review
    // histories happen on busy workspaces; capping at the first page means
    // approvalCounts misses the latest state for those PRs.
    const all: ForgejoReview[] = [];
    for (let page = 1; page < 50; page++) {
      const batch = await this.req<ForgejoReview[]>(
        `/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews?page=${page}&limit=50`,
      );
      all.push(...batch);
      if (batch.length < 50) break;
    }
    return all;
  }

  async createReview(owner: string, repo: string, index: number, opts: {
    event: "APPROVED" | "REQUEST_CHANGES" | "COMMENT" | "PENDING";
    body: string;
    comments?: Array<{ path: string; body: string; new_position?: number; old_position?: number }>;
    commit_id?: string;
  }): Promise<ForgejoReview> {
    const payload: Record<string, unknown> = { event: opts.event, body: opts.body };
    if (opts.comments && opts.comments.length > 0) payload.comments = opts.comments;
    if (opts.commit_id) payload.commit_id = opts.commit_id;
    return this.req<ForgejoReview>(`/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews`, {
      method: "POST",
      body: payload,
    });
  }

  async submitPullReview(owner: string, repo: string, index: number, reviewId: number, opts: {
    event: "APPROVED" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
  }): Promise<ForgejoReview> {
    return this.req<ForgejoReview>(
      `/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}`,
      { method: "POST", body: { event: opts.event, body: opts.body } },
    );
  }

  async addCommentToReview(owner: string, repo: string, index: number, reviewId: number, opts: {
    path: string;
    body: string;
    new_position?: number;
    old_position?: number;
  }): Promise<ForgejoPullReviewComment> {
    const payload: Record<string, unknown> = { path: opts.path, body: opts.body };
    if (opts.new_position !== undefined) payload.new_position = opts.new_position;
    if (opts.old_position !== undefined) payload.old_position = opts.old_position;
    return this.req<ForgejoPullReviewComment>(
      `/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}/comments`,
      { method: "POST", body: payload },
    );
  }

  async listReviewComments(
    owner: string, repo: string, index: number, reviewId: number,
  ): Promise<ForgejoPullReviewComment[]> {
    return this.req<ForgejoPullReviewComment[]>(
      `/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}/comments`,
    );
  }

  // All review comments on a PR in one call — no per-review fan-out.
  async listPullComments(
    owner: string, repo: string, index: number,
  ): Promise<ForgejoPullReviewComment[]> {
    try {
      return await this.req<ForgejoPullReviewComment[]>(
        `/api/v1/repos/${owner}/${repo}/pulls/${index}/comments`,
      );
    } catch (err) {
      if (!(err instanceof ForgejoError && err.status === 404)) throw err;
      const reviews = await this.listReviews(owner, repo, index);
      const nested = await Promise.all(
        reviews
          .filter((r) => r.id > 0)
          .map((r) =>
            this.listReviewComments(owner, repo, index, r.id).catch((commentErr) => {
              if (commentErr instanceof ForgejoError && commentErr.status === 404) return [];
              throw commentErr;
            }),
          ),
      );
      return nested.flat();
    }
  }

  // ---------- issues ----------

  async listIssues(
    owner: string,
    repo: string,
    opts: {
      state?: "open" | "closed" | "all";
      page?: number;
      limit?: number;
      // Forgejo accepts these as repo-scoped filters; values are Forgejo usernames.
      assigned_by?: string;
      created_by?: string;
      // Title/body free-text search. Forgejo's `q` is title-only on /issues.
      q?: string;
    } = {},
  ): Promise<ForgejoIssue[]> {
    const params = new URLSearchParams();
    params.set("type", "issues"); // exclude PRs; Forgejo's /issues endpoint returns both
    if (opts.state) params.set("state", opts.state);
    if (opts.page) params.set("page", String(opts.page));
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.assigned_by) params.set("assigned_by", opts.assigned_by);
    if (opts.created_by) params.set("created_by", opts.created_by);
    if (opts.q) params.set("q", opts.q);
    return this.req<ForgejoIssue[]>(`/api/v1/repos/${owner}/${repo}/issues?${params.toString()}`);
  }

  async getIssue(owner: string, repo: string, number: number): Promise<ForgejoIssue> {
    return this.req<ForgejoIssue>(`/api/v1/repos/${owner}/${repo}/issues/${number}`);
  }

  async listPinnedIssues(owner: string, repo: string): Promise<ForgejoIssue[]> {
    return this.req<ForgejoIssue[]>(`/api/v1/repos/${owner}/${repo}/issues/pinned`);
  }

  async listIssueTimeline(owner: string, repo: string, number: number): Promise<ForgejoTimelineEvent[]> {
    return this.req<ForgejoTimelineEvent[]>(`/api/v1/repos/${owner}/${repo}/issues/${number}/timeline`);
  }


  async removeIssueBlock(
    owner: string, repo: string, number: number, blockIndex: number,
  ): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/issues/${number}/blocks`, {
      method: "DELETE",
      body: { index: blockIndex, owner, repo },
    });
  }

  async listRepoActivities(
    owner: string,
    repo: string,
    opts: { limit?: number } = {},
  ): Promise<ForgejoActivity[]> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    return this.req<ForgejoActivity[]>(
      `/api/v1/repos/${owner}/${repo}/activities/feeds?${params.toString()}`,
    );
  }

  async createIssue(
    owner: string, repo: string,
    opts: { title: string; body: string; assignees?: string[]; labels?: number[] },
  ): Promise<ForgejoIssue> {
    const payload: Record<string, unknown> = { title: opts.title, body: opts.body };
    if (opts.assignees?.length) payload.assignees = opts.assignees;
    if (opts.labels?.length) payload.labels = opts.labels;
    return this.req<ForgejoIssue>(`/api/v1/repos/${owner}/${repo}/issues`, {
      method: "POST",
      body: payload,
    });
  }

  // ---------- notifications ----------

  // List notification threads for the user this client is bound to, scoped to
  // a single repository. Filters map directly to Forgejo's repo notification
  // query params.
  async listRepoNotifications(
    owner: string,
    repo: string,
    opts: {
      all?: boolean;
      limit?: number;
      statusTypes?: Array<"unread" | "read" | "pinned">;
      subjectTypes?: Array<"Issue" | "Pull" | "Commit" | "Repository">;
    } = {},
  ): Promise<ForgejoNotificationThread[]> {
    return this.req<ForgejoNotificationThread[]>(
      `/api/v1/repos/${owner}/${repo}/notifications`,
      {
        query: {
          all: opts.all ? "true" : undefined,
          "status-types": opts.statusTypes?.join(","),
          "subject-type": opts.subjectTypes?.join(","),
          limit: opts.limit ?? 50,
        },
      },
    );
  }

  async markNotificationRead(id: number): Promise<void> {
    await this.req(`/api/v1/notifications/threads/${id}`, {
      method: "PATCH",
      query: { "to-status": "read" },
      expectEmpty: true,
    });
  }

  async markRepoNotificationsRead(owner: string, repo: string): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/notifications`, {
      method: "PUT",
      expectEmpty: true,
    });
  }

}

function encodeFilePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}


// Type definitions live in forgejo-types.ts; re-export so existing
// `import { ForgejoIssue, ... } from "./forgejo.js"` call sites keep working.
export type {
  ForgejoIssue,
  ForgejoIssueComment,
  ForgejoActivity,
  ForgejoTimelineEvent,
  ForgejoUser,
  ForgejoRepo,
  ForgejoNotificationThread,
  ForgejoBranch,
  ForgejoBranchProtection,
  ForgejoHook,
  ForgejoContent,
  ForgejoFileResponse,
  ForgejoTreeEntry,
  ForgejoPull,
  ForgejoPullFile,
  ForgejoPullReviewComment,
  ForgejoReview,
} from "./forgejo-types.js";
