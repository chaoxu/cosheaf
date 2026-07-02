// Shared Origin API response parsing for local Workbench clients.

export class RemoteCosheafError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteCosheafError";
  }
}

// The shared Origin-response contract: non-2xx becomes a status-bearing
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
