// Thin wrapper around the Forgejo REST API.
//
// Each instance is bound to a single token. On the request path that's the
// caller's Forgejo PAT, resolved from either API bearer auth or the
// server-rendered web cookie; for out-of-band provisioning (CLI user/workspace
// creation, webhook handler) we instantiate a separate admin-bound instance.
// There is no impersonation header — Forgejo attributes every action to whoever
// owns the token.

import type {
  ForgejoActivity,
  ForgejoBranch,
  ForgejoBranchProtection,
  ForgejoCommit,
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

export async function mergePullWithRetry<T>(
  merge: () => Promise<T>,
  opts: {
    attempts?: number;
    delayMs?: (attempt: number) => number;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? ((attempt) => 250 * attempt);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await merge();
    } catch (err) {
      lastErr = err;
      const retry =
        err instanceof ForgejoError &&
        err.status === 405 &&
        /try again/i.test(err.bodyText);
      if (!retry || attempt === attempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs(attempt)));
    }
  }

  throw lastErr;
}

interface RequestOpts {
  method?: string;
  query?: Record<string, string | number | Array<string | number> | undefined>;
  body?: unknown;
  raw?: boolean;
  rawBytes?: boolean;
  expectEmpty?: boolean;
}

export class Forgejo {
  constructor(private cfg: ForgejoConfig) {}

  private async req<T = unknown>(p: string, opts: RequestOpts = {}): Promise<T> {
    const url = new URL(p.startsWith("/") ? this.cfg.baseUrl + p : p);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.set(k, String(v));
        }
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
    if (opts.rawBytes) return Buffer.from(await res.arrayBuffer()) as unknown as T;
    if (opts.raw) return (await res.text()) as unknown as T;
    if (opts.expectEmpty || res.status === 204) return undefined as T;
    const txt = await res.text();
    return (txt ? JSON.parse(txt) : undefined) as T;
  }

  // `req<T>()` that returns null on 404 instead of throwing. Used by every
  // get-or-null call (getRepo, getBranchProtection, getBranch, getPull, …).
  private async reqOpt<T>(p: string, opts: RequestOpts = {}): Promise<T | null> {
    try {
      return await this.req<T>(p, opts);
    } catch (e) {
      if (e instanceof ForgejoError && e.status === 404) return null;
      throw e;
    }
  }

  // Fetch every page of a Forgejo list endpoint. Forgejo silently truncates
  // list responses at its page size, so any list that can outgrow one page
  // goes through here. The 50-page cap (2500 rows) is a runaway guard, not a
  // surface anyone should hit.
  private async pagedList<T>(
    p: string,
    query: RequestOpts["query"] = {},
    limitParam: "limit" | "per_page" = "limit",
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await this.req<T[]>(p, { query: { ...query, page, [limitParam]: 50 } });
      if (!batch || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < 50) break;
    }
    return out;
  }

  // Compose a repo-scoped Forgejo URL. All repo-bound methods share this so
  // a rename of Forgejo's path shape (or a future owner-encoding tweak)
  // changes one place.
  private repoPath(owner: string, repo: string, suffix: string): string {
    return `/api/v1/repos/${owner}/${repo}/${suffix}`;
  }

  // ---------------- users ----------------

  async getCurrentUser(): Promise<ForgejoUser> {
    return this.req<ForgejoUser>("/api/v1/user");
  }

  async getUserByName(username: string): Promise<ForgejoUser | null> {
    return this.reqOpt<ForgejoUser>(`/api/v1/users/${encodeURIComponent(username)}`);
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

  // Site-admin only: create a repo on behalf of any user. Provisioning paths
  // that run without the owner's PAT (CLI seed) go through here.
  async createRepoForUser(username: string, opts: {
    name: string;
    description?: string;
    private?: boolean;
    auto_init?: boolean;
    default_branch?: string;
  }): Promise<ForgejoRepo> {
    return this.req<ForgejoRepo>(`/api/v1/admin/users/${encodeURIComponent(username)}/repos`, {
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

  async createOrgRepo(org: string, opts: {
    name: string;
    description?: string;
    private?: boolean;
    auto_init?: boolean;
    default_branch?: string;
  }): Promise<ForgejoRepo> {
    return this.req<ForgejoRepo>(`/api/v1/orgs/${encodeURIComponent(org)}/repos`, {
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

  // Repos visible to the calling token that carry `topic` as an exact repo
  // topic. Forgejo's topic search is exact-match only (no prefix search), so
  // workspace discovery unions one call per registered format topic.
  // /repos/search wraps results in {ok, data} rather than a bare array, so it
  // can't go through pagedList; same page-walk discipline, unwrapped here.
  async searchReposByTopic(topic: string): Promise<ForgejoRepo[]> {
    const out: ForgejoRepo[] = [];
    for (let page = 1; page <= 50; page++) {
      const res = await this.req<{ data?: ForgejoRepo[] }>("/api/v1/repos/search", {
        query: { q: topic, topic: "true", page, limit: 50 },
      });
      const batch = res.data ?? [];
      if (batch.length === 0) break;
      out.push(...batch);
      if (batch.length < 50) break;
    }
    return out;
  }

  async getRepo(owner: string, repo: string): Promise<ForgejoRepo | null> {
    return this.reqOpt<ForgejoRepo>(`/api/v1/repos/${owner}/${repo}`);
  }

  async listUserRepos(owner: string, opts: { limit?: number; page?: number } = {}): Promise<ForgejoRepo[]> {
    return this.req<ForgejoRepo[]>(`/api/v1/users/${encodeURIComponent(owner)}/repos`, {
      query: { limit: opts.limit ?? 50, page: opts.page ?? 1 },
    });
  }

  async addCollaborator(owner: string, repo: string, username: string, permission: "read" | "write" | "admin"): Promise<void> {
    await this.req(this.repoPath(owner, repo, `collaborators/${encodeURIComponent(username)}`), {
      method: "PUT",
      body: { permission },
      expectEmpty: true,
    });
  }

  async removeCollaborator(owner: string, repo: string, username: string): Promise<void> {
    await this.req(this.repoPath(owner, repo, `collaborators/${encodeURIComponent(username)}`), {
      method: "DELETE",
      expectEmpty: true,
    });
  }

  async listCollaborators(owner: string, repo: string): Promise<ForgejoUser[]> {
    return this.pagedList<ForgejoUser>(this.repoPath(owner, repo, `collaborators`));
  }

  // Returns "admin"|"write"|"read"|"none". `owner` is collapsed to `admin` so
  // routes have one fewer level to gate on. 404 on the repo (or unknown user)
  // surfaces as "none" — the workspace middleware treats that as no access.
  async getRepoPermission(
    owner: string,
    repo: string,
    username: string,
  ): Promise<"admin" | "write" | "read" | "none"> {
    const r = await this.reqOpt<{ permission?: string }>(
      this.repoPath(owner, repo, `collaborators/${encodeURIComponent(username)}/permission`),
    );
    const p = r?.permission;
    if (p === "owner" || p === "admin") return "admin";
    if (p === "write") return "write";
    if (p === "read") return "read";
    return "none";
  }

  // ---------------- branch protection ----------------

  async getBranchProtection(owner: string, repo: string, branch: string): Promise<ForgejoBranchProtection | null> {
    return this.reqOpt<ForgejoBranchProtection>(this.repoPath(owner, repo, `branch_protections/${encodeURIComponent(branch)}`));
  }

  async createBranchProtection(owner: string, repo: string, opts: {
    branch_name: string;
    required_approvals?: number;
    push_whitelist_usernames?: string[];
  }): Promise<ForgejoBranchProtection> {
    const whitelist = opts.push_whitelist_usernames ?? [];
    return this.req<ForgejoBranchProtection>(this.repoPath(owner, repo, `branch_protections`), {
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
    return this.req<ForgejoBranchProtection>(this.repoPath(owner, repo, `branch_protections/${encodeURIComponent(branch)}`), {
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
    return this.req<ForgejoBranchProtection>(this.repoPath(owner, repo, `branch_protections/${encodeURIComponent(branch)}`), {
      method: "PATCH",
      body: patch,
    });
  }

  // ---------------- webhooks ----------------

  async createRepoHook(owner: string, repo: string, url: string, secret: string, events: string[]): Promise<ForgejoHook> {
    return this.req<ForgejoHook>(this.repoPath(owner, repo, `hooks`), {
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
    return this.req<ForgejoHook[]>(this.repoPath(owner, repo, `hooks`));
  }

  // ---------------- topics ----------------

  async listRepoTopics(owner: string, repo: string): Promise<string[]> {
    const r = await this.req<{ topics?: string[] }>(this.repoPath(owner, repo, `topics`));
    return r.topics ?? [];
  }

  async replaceRepoTopics(owner: string, repo: string, topics: string[]): Promise<void> {
    await this.req<void>(this.repoPath(owner, repo, `topics`), {
      method: "PUT",
      body: { topics },
      expectEmpty: true,
    });
  }

  // ---------------- contents (files) ----------------

  async getRawFile(owner: string, repo: string, ref: string, filepath: string): Promise<string> {
    return this.req<string>(this.repoPath(owner, repo, `raw/${encodeFilePath(filepath)}`), {
      query: { ref },
      raw: true,
    });
  }

  async getRawFileBytes(owner: string, repo: string, ref: string, filepath: string): Promise<Buffer> {
    return this.req<Buffer>(this.repoPath(owner, repo, `raw/${encodeFilePath(filepath)}`), {
      query: { ref },
      rawBytes: true,
    });
  }

  async getFileMeta(owner: string, repo: string, ref: string, filepath: string): Promise<ForgejoContent | null> {
    return this.reqOpt<ForgejoContent>(this.repoPath(owner, repo, `contents/${encodeFilePath(filepath)}`), {
        query: { ref },
      });
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
    const path = this.repoPath(owner, repo, `contents/${encodeFilePath(opts.path)}`);
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
    await this.req(this.repoPath(owner, repo, `contents/${encodeFilePath(opts.path)}`), {
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
        this.repoPath(owner, repo, `git/trees/${encodeURIComponent(ref)}`),
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
    return this.req<ForgejoBranch>(this.repoPath(owner, repo, `branches`), {
      method: "POST",
      body: {
        new_branch_name: opts.newBranchName,
        old_branch_name: opts.oldBranchName ?? "main",
      },
    });
  }

  async listBranches(owner: string, repo: string): Promise<ForgejoBranch[]> {
    return this.pagedList<ForgejoBranch>(this.repoPath(owner, repo, `branches`), {}, "per_page");
  }

  async getBranch(owner: string, repo: string, branch: string): Promise<ForgejoBranch | null> {
    return this.reqOpt<ForgejoBranch>(this.repoPath(owner, repo, `branches/${encodeURIComponent(branch)}`));
  }

  async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    await this.req(this.repoPath(owner, repo, `branches/${encodeURIComponent(branch)}`), {
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
    return this.req<ForgejoPull>(this.repoPath(owner, repo, `pulls`), {
      method: "POST",
      body: { head: opts.head, base: opts.base, title: opts.title, body: opts.body },
    });
  }

  async getPull(owner: string, repo: string, index: number): Promise<ForgejoPull | null> {
    return this.reqOpt<ForgejoPull>(this.repoPath(owner, repo, `pulls/${index}`));
  }

  async listPulls(
    owner: string,
    repo: string,
    opts: {
      state?: "open" | "closed" | "all";
      labels?: number[];
      milestone?: number;
      poster?: string;
      sort?: "oldest" | "recentupdate" | "recentclose" | "leastupdate" | "mostcomment" | "leastcomment" | "priority";
    } | "open" | "closed" | "all" = {},
  ): Promise<ForgejoPull[]> {
    const options = typeof opts === "string" ? { state: opts } : opts;
    return this.pagedList<ForgejoPull>(this.repoPath(owner, repo, `pulls`), {
      state: options.state ?? "open",
      sort: options.sort ?? "recentupdate",
      milestone: options.milestone,
      poster: options.poster,
      labels: options.labels,
    });
  }

  async editPull(owner: string, repo: string, index: number, patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: number[]; milestone?: number }): Promise<ForgejoPull> {
    return this.req<ForgejoPull>(this.repoPath(owner, repo, `pulls/${index}`), {
      method: "PATCH",
      body: patch,
    });
  }

  async listPullReviewers(owner: string, repo: string): Promise<ForgejoUser[]> {
    return this.req<ForgejoUser[]>(this.repoPath(owner, repo, "reviewers"));
  }

  async createPullReviewRequests(
    owner: string,
    repo: string,
    index: number,
    reviewers: string[],
  ): Promise<void> {
    await this.req(this.repoPath(owner, repo, `pulls/${index}/requested_reviewers`), {
      method: "POST",
      body: { reviewers },
    });
  }

  async deletePullReviewRequests(
    owner: string,
    repo: string,
    index: number,
    reviewers: string[],
  ): Promise<void> {
    await this.req(this.repoPath(owner, repo, `pulls/${index}/requested_reviewers`), {
      method: "DELETE",
      body: { reviewers },
      expectEmpty: true,
    });
  }

  async mergePull(owner: string, repo: string, index: number, opts: { Do: "merge" | "squash" | "rebase"; message?: string; force?: boolean }): Promise<void> {
    await this.req(this.repoPath(owner, repo, `pulls/${index}/merge`), {
      method: "POST",
      body: { Do: opts.Do, MergeMessageField: opts.message ?? "", force_merge: opts.force ?? false },
      expectEmpty: true,
    });
  }

  async listPullFiles(owner: string, repo: string, index: number): Promise<ForgejoPullFile[]> {
    return this.req<ForgejoPullFile[]>(this.repoPath(owner, repo, `pulls/${index}/files`));
  }

  async listPullCommits(owner: string, repo: string, index: number): Promise<ForgejoCommit[]> {
    return this.pagedList<ForgejoCommit>(this.repoPath(owner, repo, `pulls/${index}/commits`));
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<ForgejoCommit> {
    return this.req<ForgejoCommit>(this.repoPath(owner, repo, `git/commits/${encodeURIComponent(sha)}`));
  }

  async getPullDiff(owner: string, repo: string, index: number): Promise<string> {
    return this.req<string>(this.repoPath(owner, repo, `pulls/${index}.diff`), { raw: true });
  }

  async listReviews(owner: string, repo: string, index: number): Promise<ForgejoReview[]> {
    // Paginate: PRs with long review histories happen on busy workspaces;
    // capping at the first page means approvalCounts misses the latest state.
    return this.pagedList<ForgejoReview>(this.repoPath(owner, repo, `pulls/${index}/reviews`));
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
    return this.req<ForgejoReview>(this.repoPath(owner, repo, `pulls/${index}/reviews`), {
      method: "POST",
      body: payload,
    });
  }

  async submitPullReview(owner: string, repo: string, index: number, reviewId: number, opts: {
    event: "APPROVED" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
  }): Promise<ForgejoReview> {
    return this.req<ForgejoReview>(
      this.repoPath(owner, repo, `pulls/${index}/reviews/${reviewId}`),
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
      this.repoPath(owner, repo, `pulls/${index}/reviews/${reviewId}/comments`),
      { method: "POST", body: payload },
    );
  }

  async deleteReviewComment(owner: string, repo: string, index: number, reviewId: number, commentId: number): Promise<void> {
    await this.req(this.repoPath(owner, repo, `pulls/${index}/reviews/${reviewId}/comments/${commentId}`), {
      method: "DELETE",
      expectEmpty: true,
    });
  }

  async listReviewComments(
    owner: string, repo: string, index: number, reviewId: number,
  ): Promise<ForgejoPullReviewComment[]> {
    return this.req<ForgejoPullReviewComment[]>(
      this.repoPath(owner, repo, `pulls/${index}/reviews/${reviewId}/comments`),
    );
  }

  // All review comments on a PR in one call — no per-review fan-out.
  async listPullComments(
    owner: string, repo: string, index: number,
  ): Promise<ForgejoPullReviewComment[]> {
    try {
      return await this.pagedList<ForgejoPullReviewComment>(
        this.repoPath(owner, repo, `pulls/${index}/comments`),
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
      mentioned_by?: string;
      labels?: string;
      milestones?: string;
      sort?: "relevance" | "latest" | "oldest" | "recentupdate" | "leastupdate" | "mostcomment" | "leastcomment" | "nearduedate" | "farduedate";
      // Title/body free-text search. Forgejo's `q` is title-only on /issues.
      q?: string;
    } = {},
  ): Promise<ForgejoIssue[]> {
    const query = {
      type: "issues", // exclude PRs; Forgejo's /issues endpoint returns both
      state: opts.state,
      assigned_by: opts.assigned_by,
      created_by: opts.created_by,
      mentioned_by: opts.mentioned_by,
      labels: opts.labels,
      milestones: opts.milestones,
      sort: opts.sort,
      q: opts.q,
    };
    // An explicit page/limit means the caller controls paging; otherwise
    // fetch the full list.
    if (opts.page !== undefined || opts.limit !== undefined) {
      return this.req<ForgejoIssue[]>(this.repoPath(owner, repo, "issues"), {
        query: { ...query, page: opts.page, limit: opts.limit },
      });
    }
    return this.pagedList<ForgejoIssue>(this.repoPath(owner, repo, "issues"), query);
  }

  async getIssue(owner: string, repo: string, number: number): Promise<ForgejoIssue> {
    return this.req<ForgejoIssue>(this.repoPath(owner, repo, `issues/${number}`));
  }

  async editIssue(
    owner: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; milestone?: number; assignees?: string[] },
  ): Promise<ForgejoIssue> {
    return this.req<ForgejoIssue>(this.repoPath(owner, repo, `issues/${number}`), {
      method: "PATCH",
      body: patch,
    });
  }

  async listPinnedIssues(owner: string, repo: string): Promise<ForgejoIssue[]> {
    return this.req<ForgejoIssue[]>(this.repoPath(owner, repo, `issues/pinned`));
  }

  async pinIssue(owner: string, repo: string, number: number): Promise<void> {
    await this.req(this.repoPath(owner, repo, `issues/${number}/pin`), {
      method: "POST",
      expectEmpty: true,
    });
  }

  async unpinIssue(owner: string, repo: string, number: number): Promise<void> {
    await this.req(this.repoPath(owner, repo, `issues/${number}/pin`), {
      method: "DELETE",
      expectEmpty: true,
    });
  }

  async listIssueComments(owner: string, repo: string, number: number): Promise<ForgejoIssueComment[]> {
    return this.pagedList<ForgejoIssueComment>(this.repoPath(owner, repo, `issues/${number}/comments`));
  }

  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<ForgejoIssueComment> {
    return this.req<ForgejoIssueComment>(this.repoPath(owner, repo, `issues/${number}/comments`), {
      method: "POST",
      body: { body },
    });
  }

  async editIssueComment(owner: string, repo: string, id: number, body: string): Promise<ForgejoIssueComment> {
    return this.req<ForgejoIssueComment>(this.repoPath(owner, repo, `issues/comments/${id}`), {
      method: "PATCH",
      body: { body },
    });
  }

  async deleteIssueComment(owner: string, repo: string, id: number): Promise<void> {
    await this.req(this.repoPath(owner, repo, `issues/comments/${id}`), {
      method: "DELETE",
      expectEmpty: true,
    });
  }

  async listLabels(owner: string, repo: string): Promise<ForgejoLabel[]> {
    return this.pagedList<ForgejoLabel>(this.repoPath(owner, repo, `labels`));
  }

  async createLabel(
    owner: string,
    repo: string,
    opts: { name: string; color: string; description?: string; exclusive?: boolean; is_archived?: boolean },
  ): Promise<ForgejoLabel> {
    return this.req<ForgejoLabel>(this.repoPath(owner, repo, `labels`), {
      method: "POST",
      body: opts,
    });
  }

  async setIssueLabels(owner: string, repo: string, number: number, labels: number[]): Promise<ForgejoLabel[]> {
    return this.req<ForgejoLabel[]>(this.repoPath(owner, repo, `issues/${number}/labels`), {
      method: "PUT",
      body: { labels },
    });
  }

  async listMilestones(
    owner: string,
    repo: string,
    state: "open" | "closed" | "all",
  ): Promise<ForgejoMilestone[]> {
    return this.pagedList<ForgejoMilestone>(this.repoPath(owner, repo, `milestones`), { state });
  }

  async createMilestone(
    owner: string,
    repo: string,
    opts: { title: string; description?: string },
  ): Promise<ForgejoMilestone> {
    return this.req<ForgejoMilestone>(this.repoPath(owner, repo, `milestones`), {
      method: "POST",
      body: opts,
    });
  }

  async renderMarkdown(owner: string, repo: string, text: string): Promise<string> {
    return this.req<string>(this.repoPath(owner, repo, `markdown`), {
      method: "POST",
      body: { Text: text, Mode: "comment", Wiki: false },
      raw: true,
    });
  }

  async listIssueTimeline(owner: string, repo: string, number: number): Promise<ForgejoTimelineEvent[]> {
    return this.pagedList<ForgejoTimelineEvent>(this.repoPath(owner, repo, `issues/${number}/timeline`));
  }

  async listIssueDependencies(owner: string, repo: string, number: number): Promise<ForgejoIssue[]> {
    return this.req<ForgejoIssue[]>(this.repoPath(owner, repo, `issues/${number}/dependencies`));
  }

  async listIssueBlocks(owner: string, repo: string, number: number): Promise<ForgejoIssue[]> {
    return this.req<ForgejoIssue[]>(this.repoPath(owner, repo, `issues/${number}/blocks`));
  }

  async addIssueDependency(
    owner: string, repo: string, number: number, dependencyIndex: number,
  ): Promise<ForgejoIssue> {
    return this.req<ForgejoIssue>(this.repoPath(owner, repo, `issues/${number}/dependencies`), {
      method: "POST",
      body: { index: dependencyIndex, owner, repo },
    });
  }

  async removeIssueDependency(
    owner: string, repo: string, number: number, dependencyIndex: number,
  ): Promise<ForgejoIssue> {
    return this.req<ForgejoIssue>(this.repoPath(owner, repo, `issues/${number}/dependencies`), {
      method: "DELETE",
      body: { index: dependencyIndex, owner, repo },
    });
  }

  async removeIssueBlock(
    owner: string, repo: string, number: number, blockIndex: number,
  ): Promise<void> {
    await this.req(this.repoPath(owner, repo, `issues/${number}/blocks`), {
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
      this.repoPath(owner, repo, `activities/feeds?${params.toString()}`),
    );
  }

  async createIssue(
    owner: string, repo: string,
    opts: { title: string; body: string; assignees?: string[]; labels?: number[] },
  ): Promise<ForgejoIssue> {
    const payload: Record<string, unknown> = { title: opts.title, body: opts.body };
    if (opts.assignees?.length) payload.assignees = opts.assignees;
    if (opts.labels?.length) payload.labels = opts.labels;
    return this.req<ForgejoIssue>(this.repoPath(owner, repo, `issues`), {
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
      this.repoPath(owner, repo, `notifications`),
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

  async getNotificationThread(id: number): Promise<ForgejoNotificationThread> {
    return this.req<ForgejoNotificationThread>(`/api/v1/notifications/threads/${id}`);
  }

  async markRepoNotificationsRead(owner: string, repo: string): Promise<void> {
    await this.req(this.repoPath(owner, repo, `notifications`), {
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
  ForgejoCommit,
  ForgejoLabel,
  ForgejoMilestone,
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
