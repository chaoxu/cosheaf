// Cosheaf has no local user table. Usernames are Forgejo usernames resolved
// from the request PAT, whether it arrived as an API bearer token or the
// server-rendered web cookie.
export interface User {
  username: string;
}
