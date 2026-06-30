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

// Render a FriendlyError as one line for a toast/banner ("message — hint").
export function friendlyLine(err: unknown): string {
  const f = friendlyGitError(err instanceof Error ? err.message : String(err));
  return f.hint ? `${f.message} ${f.hint}` : f.message;
}
