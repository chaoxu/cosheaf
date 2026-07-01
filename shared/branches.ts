export interface BranchRow {
  name: string;
  commit: {
    id: string;
    url?: string;
    timestamp?: string;
    author?: { username?: string; name?: string; email?: string };
  };
}
