// Tier 2: talk to a remote Cosheaf service for the pull-request surface the
// local Workbench can't provide itself. Uses the remote's typed Cosheaf API with
// an opaque Cosheaf token (per docs/AI_CLIENTS.md) — never a forge token, never
// a forge path. Git push itself goes over the working tree's `origin` remote
// (the user's SSH key); this client only opens / reads the PR.

// The pull operations the local pulls router needs. An interface so tests can
// inject a fake without a live remote.
export interface RemotePullClient {
  openPull(
    owner: string,
    repo: string,
    body: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number }>;
  // Browser URL of a PR on the remote, for redirecting the user after opening it.
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

  openPull(
    owner: string,
    repo: string,
    body: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number }> {
    return this.req(`/api/v1/repos/${owner}/${repo}/pulls`, { method: "POST", body: JSON.stringify(body) });
  }

  pullUrl(owner: string, repo: string, n: number): string {
    return `${this.base}/${owner}/${repo}/pulls/${n}`;
  }
}
