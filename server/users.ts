// Cosheaf has no local user state. Usernames are Forgejo usernames; the
// PAT used for every request is the client's `Authorization: Bearer` header.
// This type is the per-request user shape stashed in AppEnv.
export interface User {
  username: string;
}
