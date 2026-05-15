// Thin wrapper around the Forgejo REST API.
// All calls go through one admin token; per-user actions use the `Sudo` header.

import type {
  ForgejoActivity,
  ForgejoBranch,
  ForgejoBranchProtection,
  ForgejoContent,
  ForgejoFileResponse,
  ForgejoHook,
  ForgejoIssue,
  ForgejoIssueComment,
  ForgejoLabel,
  ForgejoMilestone,
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
  adminToken: string;
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
  sudo?: string;
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
      authorization: `token ${this.cfg.adminToken}`,
      accept: "application/json",
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.sudo) headers.sudo = opts.sudo;

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
  }, sudo: string): Promise<ForgejoRepo> {
    return this.req<ForgejoRepo>("/api/v1/user/repos", {
      method: "POST",
      sudo,
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
    sudo: string;
  }): Promise<ForgejoFileResponse> {
    const isUpdate = !!opts.sha;
    const body = {
      branch: opts.branch,
      content: Buffer.from(opts.content, "utf8").toString("base64"),
      message: opts.message,
      ...(isUpdate ? { sha: opts.sha } : {}),
    };
    const path = `/api/v1/repos/${owner}/${repo}/contents/${encodeFilePath(opts.path)}`;
    return this.req<ForgejoFileResponse>(path, {
      method: isUpdate ? "PUT" : "POST",
      body,
      sudo: opts.sudo,
    });
  }

  async deleteFile(owner: string, repo: string, opts: {
    branch: string;
    path: string;
    sha: string;
    message: string;
    sudo: string;
  }): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/contents/${encodeFilePath(opts.path)}`, {
      method: "DELETE",
      body: { branch: opts.branch, sha: opts.sha, message: opts.message },
      sudo: opts.sudo,
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

  async createBranch(owner: string, repo: string, opts: { newBranchName: string; oldBranchName?: string; sudo: string }): Promise<ForgejoBranch> {
    return this.req<ForgejoBranch>(`/api/v1/repos/${owner}/${repo}/branches`, {
      method: "POST",
      sudo: opts.sudo,
      body: {
        new_branch_name: opts.newBranchName,
        old_branch_name: opts.oldBranchName ?? "main",
      },
    });
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
    sudo: string;
  }): Promise<ForgejoPull> {
    return this.req<ForgejoPull>(`/api/v1/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      sudo: opts.sudo,
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

  async editPull(owner: string, repo: string, index: number, patch: { title?: string; body?: string; state?: "open" | "closed" }, sudo?: string): Promise<ForgejoPull> {
    return this.req<ForgejoPull>(`/api/v1/repos/${owner}/${repo}/pulls/${index}`, {
      method: "PATCH",
      body: patch,
      sudo,
    });
  }

  async mergePull(owner: string, repo: string, index: number, opts: { Do: "merge" | "squash" | "rebase"; sudo: string; message?: string }): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/pulls/${index}/merge`, {
      method: "POST",
      sudo: opts.sudo,
      body: { Do: opts.Do, MergeMessageField: opts.message ?? "" },
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
    return this.req<ForgejoReview[]>(`/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews`);
  }

  async createReview(owner: string, repo: string, index: number, opts: {
    event: "APPROVED" | "REQUEST_CHANGES" | "COMMENT" | "PENDING";
    body: string;
    sudo: string;
    comments?: Array<{ path: string; body: string; new_position?: number; old_position?: number }>;
    commit_id?: string;
  }): Promise<ForgejoReview> {
    const payload: Record<string, unknown> = { event: opts.event, body: opts.body };
    if (opts.comments && opts.comments.length > 0) payload.comments = opts.comments;
    if (opts.commit_id) payload.commit_id = opts.commit_id;
    return this.req<ForgejoReview>(`/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews`, {
      method: "POST",
      sudo: opts.sudo,
      body: payload,
    });
  }

  async submitPullReview(owner: string, repo: string, index: number, reviewId: number, opts: {
    event: "APPROVED" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
    sudo: string;
  }): Promise<ForgejoReview> {
    return this.req<ForgejoReview>(
      `/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}`,
      { method: "POST", sudo: opts.sudo, body: { event: opts.event, body: opts.body } },
    );
  }

  async addCommentToReview(owner: string, repo: string, index: number, reviewId: number, opts: {
    path: string;
    body: string;
    new_position?: number;
    old_position?: number;
    sudo: string;
  }): Promise<ForgejoPullReviewComment> {
    const payload: Record<string, unknown> = { path: opts.path, body: opts.body };
    if (opts.new_position !== undefined) payload.new_position = opts.new_position;
    if (opts.old_position !== undefined) payload.old_position = opts.old_position;
    return this.req<ForgejoPullReviewComment>(
      `/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}/comments`,
      { method: "POST", sudo: opts.sudo, body: payload },
    );
  }

  async listReviewComments(
    owner: string, repo: string, index: number, reviewId: number,
  ): Promise<ForgejoPullReviewComment[]> {
    return this.req<ForgejoPullReviewComment[]>(
      `/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}/comments`,
    );
  }

  // Forgejo doesn't expose PATCH on /pulls/.../reviews/{id}/comments/{cid}
  // (only GET/DELETE). Review-comment edits go through the generic
  // issue-comment endpoint, which Forgejo treats as the same record.
  async editReviewComment(
    owner: string, repo: string, commentId: number, body: string, sudo: string,
  ): Promise<ForgejoPullReviewComment> {
    return this.req<ForgejoPullReviewComment>(
      `/api/v1/repos/${owner}/${repo}/issues/comments/${commentId}`,
      { method: "PATCH", sudo, body: { body } },
    );
  }

  async deleteReviewComment(
    owner: string, repo: string, index: number, reviewId: number, commentId: number, sudo: string,
  ): Promise<void> {
    await this.req<unknown>(
      `/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}/comments/${commentId}`,
      { method: "DELETE", sudo, expectEmpty: true },
    );
  }

  // ---------- issues ----------

  async listIssues(
    owner: string, repo: string, opts: { state?: "open" | "closed" | "all"; page?: number; limit?: number } = {},
  ): Promise<ForgejoIssue[]> {
    const params = new URLSearchParams();
    params.set("type", "issues"); // exclude PRs; Forgejo's /issues endpoint returns both
    if (opts.state) params.set("state", opts.state);
    if (opts.page) params.set("page", String(opts.page));
    if (opts.limit) params.set("limit", String(opts.limit));
    return this.req<ForgejoIssue[]>(`/api/v1/repos/${owner}/${repo}/issues?${params.toString()}`);
  }

  async getIssue(owner: string, repo: string, number: number): Promise<ForgejoIssue> {
    return this.req<ForgejoIssue>(`/api/v1/repos/${owner}/${repo}/issues/${number}`);
  }

  async listPinnedIssues(owner: string, repo: string): Promise<ForgejoIssue[]> {
    return this.req<ForgejoIssue[]>(`/api/v1/repos/${owner}/${repo}/issues/pinned`);
  }

  async pinIssue(owner: string, repo: string, number: number, sudo: string): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/issues/${number}/pin`, {
      method: "POST",
      sudo,
      expectEmpty: true,
    });
  }

  async unpinIssue(owner: string, repo: string, number: number, sudo: string): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/issues/${number}/pin`, {
      method: "DELETE",
      sudo,
      expectEmpty: true,
    });
  }

  async listIssueTimeline(owner: string, repo: string, number: number): Promise<ForgejoTimelineEvent[]> {
    return this.req<ForgejoTimelineEvent[]>(`/api/v1/repos/${owner}/${repo}/issues/${number}/timeline`);
  }

  // ---------- milestones ----------

  async listMilestones(
    owner: string,
    repo: string,
    state: "open" | "closed" | "all" = "open",
  ): Promise<ForgejoMilestone[]> {
    return this.req<ForgejoMilestone[]>(`/api/v1/repos/${owner}/${repo}/milestones?state=${state}`);
  }

  async createMilestone(
    owner: string, repo: string,
    opts: { title: string; description?: string; due_on?: string; sudo: string },
  ): Promise<ForgejoMilestone> {
    return this.req<ForgejoMilestone>(`/api/v1/repos/${owner}/${repo}/milestones`, {
      method: "POST",
      sudo: opts.sudo,
      body: {
        title: opts.title,
        description: opts.description ?? "",
        ...(opts.due_on ? { due_on: opts.due_on } : {}),
      },
    });
  }

  async editMilestone(
    owner: string, repo: string, id: number,
    opts: { title?: string; description?: string; state?: "open" | "closed"; sudo: string },
  ): Promise<ForgejoMilestone> {
    const payload: Record<string, unknown> = {};
    if (opts.title !== undefined) payload.title = opts.title;
    if (opts.description !== undefined) payload.description = opts.description;
    if (opts.state !== undefined) payload.state = opts.state;
    return this.req<ForgejoMilestone>(`/api/v1/repos/${owner}/${repo}/milestones/${id}`, {
      method: "PATCH",
      sudo: opts.sudo,
      body: payload,
    });
  }

  async listIssueDependencies(owner: string, repo: string, number: number): Promise<ForgejoIssue[]> {
    return this.req<ForgejoIssue[]>(`/api/v1/repos/${owner}/${repo}/issues/${number}/dependencies`);
  }

  async addIssueDependency(
    owner: string, repo: string, number: number, depIndex: number, sudo: string,
  ): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/issues/${number}/dependencies`, {
      method: "POST",
      sudo,
      body: { index: depIndex, owner, repo },
    });
  }

  async removeIssueDependency(
    owner: string, repo: string, number: number, depIndex: number, sudo: string,
  ): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/issues/${number}/dependencies`, {
      method: "DELETE",
      sudo,
      body: { index: depIndex, owner, repo },
    });
  }

  async listIssueBlocks(owner: string, repo: string, number: number): Promise<ForgejoIssue[]> {
    return this.req<ForgejoIssue[]>(`/api/v1/repos/${owner}/${repo}/issues/${number}/blocks`);
  }

  async addIssueBlock(
    owner: string, repo: string, number: number, blockIndex: number, sudo: string,
  ): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/issues/${number}/blocks`, {
      method: "POST",
      sudo,
      body: { index: blockIndex, owner, repo },
    });
  }

  async removeIssueBlock(
    owner: string, repo: string, number: number, blockIndex: number, sudo: string,
  ): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/issues/${number}/blocks`, {
      method: "DELETE",
      sudo,
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
    opts: { title: string; body: string; assignees?: string[]; labels?: number[]; sudo: string },
  ): Promise<ForgejoIssue> {
    const payload: Record<string, unknown> = { title: opts.title, body: opts.body };
    if (opts.assignees?.length) payload.assignees = opts.assignees;
    if (opts.labels?.length) payload.labels = opts.labels;
    return this.req<ForgejoIssue>(`/api/v1/repos/${owner}/${repo}/issues`, {
      method: "POST",
      sudo: opts.sudo,
      body: payload,
    });
  }

  async editIssue(
    owner: string, repo: string, number: number,
    opts: {
      title?: string; body?: string; state?: "open" | "closed";
      assignees?: string[]; milestone?: number | null; sudo: string;
    },
  ): Promise<ForgejoIssue> {
    const payload: Record<string, unknown> = {};
    if (opts.title !== undefined) payload.title = opts.title;
    if (opts.body !== undefined) payload.body = opts.body;
    if (opts.state !== undefined) payload.state = opts.state;
    if (opts.assignees !== undefined) payload.assignees = opts.assignees;
    if (opts.milestone !== undefined) payload.milestone = opts.milestone ?? 0;
    return this.req<ForgejoIssue>(`/api/v1/repos/${owner}/${repo}/issues/${number}`, {
      method: "PATCH",
      sudo: opts.sudo,
      body: payload,
    });
  }

  async listIssueComments(owner: string, repo: string, number: number): Promise<ForgejoIssueComment[]> {
    return this.req<ForgejoIssueComment[]>(`/api/v1/repos/${owner}/${repo}/issues/${number}/comments`);
  }

  async createIssueComment(
    owner: string, repo: string, number: number, body: string, sudo: string,
  ): Promise<ForgejoIssueComment> {
    return this.req<ForgejoIssueComment>(`/api/v1/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      sudo,
      body: { body },
    });
  }

  async editIssueComment(
    owner: string, repo: string, commentId: number, body: string, sudo: string,
  ): Promise<ForgejoIssueComment> {
    return this.req<ForgejoIssueComment>(`/api/v1/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      method: "PATCH",
      sudo,
      body: { body },
    });
  }

  async deleteIssueComment(
    owner: string, repo: string, commentId: number, sudo: string,
  ): Promise<void> {
    await this.req<unknown>(
      `/api/v1/repos/${owner}/${repo}/issues/comments/${commentId}`,
      { method: "DELETE", sudo, expectEmpty: true },
    );
  }

  // ---------- notifications ----------

  // List unread notification threads for the calling user (via Sudo), scoped
  // to a single repository. Forgejo returns subjects of type "Issue"/"Pull"/
  // "Commit"; we filter to Issue/Pull at the route layer.
  async listRepoNotifications(
    owner: string, repo: string, sudo: string, opts: { all?: boolean; limit?: number } = {},
  ): Promise<ForgejoNotificationThread[]> {
    return this.req<ForgejoNotificationThread[]>(
      `/api/v1/repos/${owner}/${repo}/notifications`,
      {
        sudo,
        query: {
          all: opts.all ? "true" : undefined,
          limit: opts.limit ?? 50,
        },
      },
    );
  }

  async markNotificationRead(id: number, sudo: string): Promise<void> {
    await this.req(`/api/v1/notifications/threads/${id}`, {
      method: "PATCH",
      sudo,
      query: { "to-status": "read" },
      expectEmpty: true,
    });
  }

  async markRepoNotificationsRead(owner: string, repo: string, sudo: string): Promise<void> {
    await this.req(`/api/v1/repos/${owner}/${repo}/notifications`, {
      method: "PUT",
      sudo,
      expectEmpty: true,
    });
  }

  // ---------- labels ----------

  async listLabels(owner: string, repo: string): Promise<ForgejoLabel[]> {
    return this.req<ForgejoLabel[]>(`/api/v1/repos/${owner}/${repo}/labels`);
  }

  async createLabel(
    owner: string, repo: string, opts: { name: string; color: string; description?: string; sudo: string },
  ): Promise<ForgejoLabel> {
    return this.req<ForgejoLabel>(`/api/v1/repos/${owner}/${repo}/labels`, {
      method: "POST",
      sudo: opts.sudo,
      body: { name: opts.name, color: opts.color, description: opts.description ?? "" },
    });
  }

  async setIssueLabels(
    owner: string, repo: string, number: number, labelIds: number[], sudo: string,
  ): Promise<ForgejoLabel[]> {
    return this.req<ForgejoLabel[]>(`/api/v1/repos/${owner}/${repo}/issues/${number}/labels`, {
      method: "PUT",
      sudo,
      body: { labels: labelIds },
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
  ForgejoMilestone,
  ForgejoActivity,
  ForgejoTimelineEvent,
  ForgejoLabel,
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
