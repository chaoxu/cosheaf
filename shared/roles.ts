// Workspace membership role vocabulary. Server and client both import this;
// the SQLite CHECK clause in schema.sql mirrors ROLES.

export const ROLES = ["owner", "verifier", "member"] as const;
export type Role = (typeof ROLES)[number];
