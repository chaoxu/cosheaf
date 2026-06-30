// Tier 2: talk to a remote Cosheaf service for the pull-request surface the
// local Workbench can't provide itself. Uses the remote's typed Cosheaf API with
// an opaque Cosheaf token (per docs/AI_CLIENTS.md) — never a forge token, never
// a forge path. Git push itself goes over the working tree's `origin` remote
// (the user's SSH key); this client only opens / reads the PR.

// A pull request as the Workbench displays it — the subset of the remote's
// typed PrMeta the read-only PR list needs.
export interface RemotePullSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  author_username: string;
  head_ref: string;
  base_ref: string;
}

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
  // Browser URL of a PR on the remote, for linking/redirecting the user.
  pullUrl(owner: string, repo: string, n: number): string;
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

export class RemoteCosheafClient implements RemotePullClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private token: string,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new RemoteCosheafError(res.status, `remote cosheaf ${res.status}: ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async whoami(): Promise<{ username: string } | null> {
    const r = await this.req<{ user: { username: string } | null }>("/api/v1/me");
    return r.user;
  }

  openPull(
    owner: string,
    repo: string,
    body: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number }> {
    return this.req(`/api/v1/repos/${owner}/${repo}/pulls`, { method: "POST", body: JSON.stringify(body) });
  }

  async listPulls(owner: string, repo: string, state: "open" | "closed" | "all"): Promise<RemotePullSummary[]> {
    const r = await this.req<{ pulls: RemotePullSummary[] }>(
      `/api/v1/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}`,
    );
    return r.pulls ?? [];
  }

  pullUrl(owner: string, repo: string, n: number): string {
    return `${this.base}/${owner}/${repo}/pulls/${n}`;
  }
}
