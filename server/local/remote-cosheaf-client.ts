// Tier 2: talk to a remote Cosheaf service for the surface the local Workbench
// can't provide itself. Uses the remote's typed Cosheaf API with an opaque
// Cosheaf token (per docs/AI_CLIENTS.md) — never a forge token, never a forge
// path. Git push itself goes over the working tree's `origin` remote (the user's
// SSH key); this client opens / reads the PR and probes remote identity.

import type { PrMeta } from "../../shared/review.js";

// A pull request as the Workbench displays it — derived as the exact subset of
// the remote's typed PrMeta the read-only PR list needs, so a rename on PrMeta
// is a compile error here instead of a silent mis-map.
export type RemotePullSummary = Pick<
  PrMeta,
  "number" | "title" | "state" | "merged" | "author_username" | "head_ref" | "base_ref"
>;

// The remote operations the local Workbench needs. An interface so tests can
// inject a fake without a live remote.
export interface RemotePullClient {
  // Identity check: who the configured token authenticates as on the remote, or
  // null when the token is rejected. Used to validate a Connect form and to show
  // "connected as <user>" so the user knows which account they act through.
  whoami(): Promise<{ username: string } | null>;
  openPull(
    owner: string,
    repo: string,
    body: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number }>;
  // The remote's open/closed pull requests, for the read-only local PR list.
  listPulls(owner: string, repo: string, state: "open" | "closed" | "all"): Promise<RemotePullSummary[]>;
  // The commit id the remote Cosheaf server observes for a branch, or null when
  // the branch is not visible there yet.
  branchHead(owner: string, repo: string, branch: string): Promise<string | null>;
  // Browser URL of a PR on the remote, for linking/redirecting the user.
  pullUrl(owner: string, repo: string, n: number): string;
}

export interface CosheafMeResponse {
  user: { username: string } | null;
}

interface CosheafBranchResponse {
  name: string;
  commit?: { id?: string };
}

export class RemoteCosheafError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteCosheafError";
  }
}

// The shared Origin-response contract both remote clients (this one and
// OriginCollaborationClient) use: non-2xx becomes a status-bearing
// RemoteCosheafError (body truncated so an internal URL never leaks), and an
// empty body parses to undefined.
export async function parseOriginResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new RemoteCosheafError(res.status, `remote cosheaf ${res.status}: ${text.slice(0, 200)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CosheafOriginClient implements RemotePullClient {
  private readonly base: string;
  private readonly fetchFn: FetchLike;

  constructor(
    baseUrl: string,
    private readonly token: string,
    opts: { fetch?: FetchLike } = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? fetch;
  }

  private apiPath(...segments: string[]): string {
    return `/api/v1/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  }

  private repoPath(owner: string, repo: string, suffix: string): string {
    return `${this.apiPath("repos", owner, repo)}${suffix}`;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    return parseOriginResponse<T>(res);
  }

  me(): Promise<CosheafMeResponse> {
    return this.req(this.apiPath("me"));
  }

  async whoami(): Promise<{ username: string } | null> {
    const r = await this.me();
    return r.user;
  }

  openPull(
    owner: string,
    repo: string,
    body: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number }> {
    return this.req(this.repoPath(owner, repo, "/pulls"), { method: "POST", body: JSON.stringify(body) });
  }

  async listPulls(owner: string, repo: string, state: "open" | "closed" | "all"): Promise<RemotePullSummary[]> {
    const r = await this.req<{ pulls: RemotePullSummary[] }>(
      `${this.repoPath(owner, repo, "/pulls")}?state=${encodeURIComponent(state)}`,
    );
    return r.pulls ?? [];
  }

  async branchHead(owner: string, repo: string, branch: string): Promise<string | null> {
    const branches = await this.req<CosheafBranchResponse[]>(this.repoPath(owner, repo, "/branches"));
    return branches.find((candidate) => candidate.name === branch)?.commit?.id ?? null;
  }

  pullUrl(owner: string, repo: string, n: number): string {
    return `${this.base}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${n}`;
  }
}

export const RemoteCosheafClient = CosheafOriginClient;
