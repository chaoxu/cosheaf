// Forgejo API wire shapes shared by the SPA client (src/cosheaf/api.ts)
// and the server's typed-route converters. The server has fuller types
// in server/forgejo-types.ts for things it consumes more deeply; these
// shapes are the SPA-friendly subset (minimal fields, optional where
// the client is defensive).
//
// Keeping them in shared/ so:
//   - the SPA doesn't redeclare an out-of-date copy of fields the server
//     already validates against
//   - a Forgejo upstream rename caught by the server compiler also bites
//     the SPA

export interface ForgejoMilestoneRef {
  id: number;
  title: string;
  description?: string;
  state: "open" | "closed";
  open_issues: number;
  closed_issues: number;
  due_on?: string | null;
}

export interface ForgejoIssueCommentRaw {
  id: number;
  body: string;
  user?: { login?: string } | null;
  created_at: string;
  updated_at: string;
}

export interface ForgejoPullRaw {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed" | string;
  merged?: boolean | null;
  user?: { login?: string } | null;
  created_at: string;
  merged_at?: string | null;
  mergeable?: boolean | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
}
