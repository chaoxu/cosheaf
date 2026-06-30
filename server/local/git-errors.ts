// Map raw git / remote-API failures to a clear, actionable message for the
// Workbench UI. The git CLI speaks in stderr lines a user can't act on ("fatal:
// non-fast-forward …"); this turns the common Tier-1/Tier-2 failures into one
// sentence that says what to do next. Falls back to the first stderr line.

export interface FriendlyError {
  message: string;
  // A follow-up action, when there is an obvious one ("Set your profile…").
  hint?: string;
}

export function friendlyGitError(raw: string): FriendlyError {
  const m = raw.toLowerCase();
  if (m.includes("author identity unknown") || m.includes("please tell me who you are") || m.includes("empty ident")) {
    return {
      message: "Git doesn't know who you are yet.",
      hint: "Set your name and email on the Profile page, then try again.",
    };
  }
  if (m.includes("non-fast-forward") || m.includes("fetch first") || m.includes("[rejected]")) {
    return {
      message: "The remote has commits you don't have locally.",
      hint: "Sync (fetch + fast-forward) first, then push again.",
    };
  }
  if (
    m.includes("permission denied (publickey)") ||
    m.includes("could not read from remote repository") ||
    m.includes("authentication failed")
  ) {
    return {
      message: "Git couldn't authenticate to the remote.",
      hint: "Check that your SSH key is set up for this host (git push works from your terminal?).",
    };
  }
  if (
    m.includes("no configured push destination") ||
    m.includes("does not appear to be a git repository") ||
    m.includes("no such remote")
  ) {
    return {
      message: "No git remote is configured for this folder.",
      hint: "Add one with `git remote add origin <url>`, then retry.",
    };
  }
  if (m.includes("not a git repository")) {
    return { message: "This folder isn't a git repository.", hint: "Run `git init` to enable commits." };
  }
  if (m.includes("not possible to fast-forward") || m.includes("diverging") || m.includes("would be overwritten")) {
    return {
      message: "Local and remote history have diverged.",
      hint: "Merge or rebase in your terminal, then come back.",
    };
  }
  const firstLine = raw.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "Git command failed.";
  return { message: firstLine.slice(0, 200) };
}

// Node's fetch reports network/TLS failures as a generic "fetch failed" with the
// real reason on err.cause.code — map the common ones (Tier-2 Connect/whoami hits
// these against a remote Cosheaf) to something the user can act on.
function friendlyFetchCause(code: string): FriendlyError | null {
  switch (code) {
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "CERT_HAS_EXPIRED":
      return {
        message: "The remote's TLS certificate isn't trusted by the Workbench.",
        hint: "For an internal host (e.g. *.lab) relaunch with NODE_EXTRA_CA_CERTS=/path/to/ca.pem (or COSHEAF_CA_FILE); a public-cert or plain-http URL needs no CA.",
      };
    case "ECONNREFUSED":
      return { message: "Connection refused by the remote.", hint: "Check the URL and port, and that the Cosheaf server is running." };
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return { message: "Couldn't resolve that host.", hint: "Check the URL, and that this machine can reach it." };
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return { message: "Timed out reaching the remote.", hint: "Check the host is reachable from here." };
    default:
      return null;
  }
}

// Render an error as one actionable line for a toast/banner. Prefers a fetch
// cause (TLS/DNS/refused) when present, else maps the git/remote message.
export function friendlyLine(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  if (cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string") {
    const f = friendlyFetchCause((cause as { code: string }).code);
    if (f) return f.hint ? `${f.message} ${f.hint}` : f.message;
  }
  const f = friendlyGitError(err instanceof Error ? err.message : String(err));
  return f.hint ? `${f.message} ${f.hint}` : f.message;
}
