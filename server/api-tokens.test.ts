import { describe, expect, it } from "vitest";
import { deleteApiToken, mintApiToken, resolveApiToken } from "./api-tokens.js";
import { freshTestDb } from "./routes/test-fixtures.js";

describe("api token mint/resolve round-trip", () => {
  it("a minted opaque token resolves to its username + backend credential", () => {
    const db = freshTestDb("api-tokens-");
    const token = mintApiToken(db, "alice", "backend-pat-123");
    expect(token.startsWith("cosheaf_")).toBe(true);
    // Regression guard: the value handed to the client (cookie / Bearer) MUST be
    // this opaque token, and it must resolve. Setting the raw backend PAT instead
    // (the old web-login bug) left every web session looping to /login.
    expect(resolveApiToken(db, token)).toEqual({ username: "alice", forgejoToken: "backend-pat-123" });
  });

  it("a raw backend PAT (not an opaque token) does not resolve", () => {
    const db = freshTestDb("api-tokens-");
    expect(resolveApiToken(db, "a-raw-backend-pat")).toBeNull();
  });

  it("a deleted token stops resolving", () => {
    const db = freshTestDb("api-tokens-");
    const token = mintApiToken(db, "bob", "pat");
    deleteApiToken(db, token);
    expect(resolveApiToken(db, token)).toBeNull();
  });
});
