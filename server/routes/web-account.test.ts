import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { handleAppError } from "./error-handler.js";
import { web } from "./web.js";
import { fakeForgejo, freshTestDb, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("web-account");

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = testApp(db, config, (hono) => hono.route("/", web));
  app.onError(handleAppError);
  return app;
}

// Hono's `app.request(path, init, env)` third arg is the Env, not extra
// headers — the cookie must ride in the init's own headers.
function form(fields: Record<string, string>, token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://localhost",
      ...(token ? { cookie: `cosheaf_pat=${token}` } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  };
}

function multipart(fields: Record<string, string | File>, token: string): RequestInit {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return {
    method: "POST",
    headers: {
      origin: "http://localhost",
      cookie: `cosheaf_pat=${token}`,
    },
    body,
  };
}

describe("POST /account/settings (profile)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("trims the form fields, PATCHes Forgejo, and redirects with saved=1", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    let patched: unknown;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.patch("/api/v1/user/settings", async (c) => {
          patched = await c.req.json();
          return c.json({ id: 1, login: "alice" });
        });
      }),
    );

    const res = await appFor(db).request(
      "/account/settings",
      form({ full_name: "  Alice A  ", description: " bio ", website: "", location: "Mars" }, token),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/settings?saved=1");
    expect(patched).toEqual({ full_name: "Alice A", description: "bio", website: "", location: "Mars" });
  });

  it("redirects with an error when Forgejo rejects the edit", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.patch("/api/v1/user/settings", (c) => c.text("nope", 422 as 200));
      }),
    );

    const res = await appFor(db).request(
      "/account/settings",
      form({ full_name: "x", description: "", website: "", location: "" }, token),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/account\/settings\?error=/);
  });

  it("redirects to login when unauthenticated", async () => {
    const db = freshTestDb("cosheaf-account-");
    const res = await appFor(db).request("/account/settings", form({ full_name: "x" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("renders the profile form prefilled from Forgejo on GET", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/user", (c) =>
          c.json({ id: 1, login: "alice", email: "a@x.test", full_name: "Alice A", location: "Mars" }),
        );
        forge.get("/api/v1/user/keys", () => Response.json([]));
      }),
    );

    const res = await appFor(db).request("/account/settings", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="profile-form"');
    expect(body).toContain('value="Alice A"');
    expect(body).toContain('value="Mars"');
    // email is shown read-only
    expect(body).toContain('value="a@x.test"');
    expect(body).toContain('data-testid="settings-ssh-keys"');
    expect(body).toContain('data-testid="ssh-key-form"');
    expect(body).toContain("No SSH keys yet.");
    expect(body).toContain("without a Cosheaf password");
  });

  it("renders existing SSH keys from Forgejo on GET", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/user", () => Response.json({ id: 1, login: "alice" }));
        forge.get("/api/v1/user/keys", () =>
          Response.json([{ id: 7, title: "Laptop", key: "ssh-ed25519 AAAA", fingerprint: "SHA256:abc" }]),
        );
      }),
    );

    const res = await appFor(db).request("/account/settings", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Laptop");
    expect(body).toContain("SHA256:abc");
    expect(body).toContain('name="id" value="7"');
  });

  it("adds an SSH public key through Forgejo and redirects with ssh_key=1", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    let created: unknown;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.post("/api/v1/user/keys", async (c) => {
          created = await c.req.json();
          return c.json({ id: 8, title: "Work laptop", key: "ssh-ed25519 AAAA..." });
        });
      }),
    );

    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE9wZW5zc2hQdWJsaWNLZXlQbGFjZWhvbGRlcg== alice@laptop";
    const res = await appFor(db).request("/account/ssh-keys", form({ title: " Work laptop ", key }, token));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/settings?ssh_key=1");
    expect(created).toEqual({ title: "Work laptop", key });
  });

  it("rejects malformed SSH keys before contacting Forgejo", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(fakeForgejo(() => {}));

    const res = await appFor(db).request("/account/ssh-keys", form({ title: "bad", key: "not a key" }, token));

    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("valid SSH public key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes an SSH key through Forgejo", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    const deleted: string[] = [];
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.delete("/api/v1/user/keys/:id", (c) => {
          deleted.push(c.req.param("id"));
          return c.body(null, 204);
        });
      }),
    );

    const res = await appFor(db).request("/account/ssh-keys/delete", form({ id: "7" }, token));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/settings?ssh_key=1");
    expect(deleted).toEqual(["7"]);
  });
});

describe("GET /users/:username", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders a Forgejo-backed user profile page with visible repositories", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/user", () => Response.json({ id: 1, login: "alice" }));
        forge.get("/api/v1/users/bob", () =>
          Response.json({
            id: 2,
            login: "bob",
            full_name: "Bob Builder",
            description: "Builds notes.",
            website: "https://example.test/bob",
            location: "Moon",
          }),
        );
        forge.get("/api/v1/users/bob/repos", () =>
          Response.json([
            {
              id: 10,
              name: "notes",
              full_name: "bob/notes",
              description: "Public notes",
              owner: { id: 2, login: "bob" },
            },
          ]),
        );
      }),
    );

    const res = await appFor(db).request("/users/bob", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="user-page"');
    expect(body).toContain("Bob Builder");
    expect(body).toContain("Builds notes.");
    expect(body).toContain("https://example.test/bob");
    expect(body).toContain('href="/bob/notes"');
  });

  it("returns a not-found page when Forgejo has no such user", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/user", () => Response.json({ id: 1, login: "alice" }));
        forge.get("/api/v1/users/missing", (c) => c.text("not found", 404 as 200));
        forge.get("/api/v1/users/missing/repos", () => Response.json([]));
      }),
    );

    const res = await appFor(db).request("/users/missing", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("User not found");
  });
});

describe("POST /account/avatar", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uploads supported image bytes as a raw base64 Forgejo avatar payload", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    let payload: unknown;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.post("/api/v1/user/avatar", async (c) => {
          payload = await c.req.json();
          return c.body(null, 204);
        });
      }),
    );

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "avatar.png", { type: "image/png" });
    const res = await appFor(db).request("/account/avatar", multipart({ avatar: file }, token));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/settings?saved=1");
    expect(payload).toEqual({ image: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") });
  });

  it("rejects unsupported image MIME types before contacting Forgejo", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(fakeForgejo(() => {}));

    const file = new File(["<svg></svg>"], "avatar.svg", { type: "image/svg+xml" });
    const res = await appFor(db).request("/account/avatar", multipart({ avatar: file }, token));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/account/settings?error=");
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("PNG, JPEG, GIF, or WebP");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects clearly oversized uploads before parsing or contacting Forgejo", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(fakeForgejo(() => {}));

    const res = await appFor(db).request("/account/avatar", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=avatar",
        "content-length": "1100000",
        origin: "http://localhost",
        cookie: `cosheaf_pat=${token}`,
      },
      body: "not parsed",
    });

    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("under 1 MB");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirects malformed multipart uploads without contacting Forgejo", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(fakeForgejo(() => {}));

    const res = await appFor(db).request("/account/avatar", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=missing",
        origin: "http://localhost",
        cookie: `cosheaf_pat=${token}`,
      },
      body: "not multipart",
    });

    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("Could not read profile picture upload");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes the Forgejo avatar", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    let removed = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.delete("/api/v1/user/avatar", (c) => {
          removed = true;
          return c.body(null, 204);
        });
      }),
    );

    const res = await appFor(db).request("/account/avatar/remove", form({}, token));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/settings?saved=1");
    expect(removed).toBe(true);
  });
});

describe("GET /forge-avatars/*", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves Forgejo avatar query parameters", async () => {
    const db = freshTestDb("cosheaf-account-");
    let size: string | null = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/avatars/custom-hash", (c) => {
          size = c.req.query("size") ?? null;
          return new Response("image", { headers: { "content-type": "image/png" } });
        });
      }),
    );

    const res = await appFor(db).request("/forge-avatars/avatars/custom-hash?size=84");

    expect(res.status).toBe(200);
    expect(size).toBe("84");
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

describe("GET account notifications", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces inbox fragment list failures instead of rendering an empty inbox", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/notifications", () => new Response("down", { status: 503 }));
      }),
    );

    const res = await appFor(db).request("/account/inbox", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("backing forge failed");
    expect(body).not.toContain("home-inbox");
  });

  it("surfaces account notification page list failures instead of rendering caught-up state", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/notifications", () => new Response("down", { status: 503 }));
      }),
    );

    const res = await appFor(db).request("/account/notifications", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("backing forge failed");
    expect(body).not.toContain('data-testid="notifications-empty"');
  });

  it("keeps the home workspace list usable when the inbox summary fails", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/search", (c) =>
          c.json({
            data: [
              {
                id: 1,
                name: "w",
                full_name: "owner/w",
                default_branch: "main",
                description: "Workspace",
                owner: { id: 1, login: "owner" },
                permissions: { admin: false, push: true, pull: true },
                private: true,
                topics: [],
              },
            ],
          }),
        );
        forge.get("/api/v1/notifications", () => new Response("down", { status: 503 }));
        forge.get("/api/v1/user", (c) => c.json({ login: "alice" }));
      }),
    );

    const res = await appFor(db).request("/", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("owner/w");
    expect(body).toContain('data-testid="home-inbox-unavailable"');
  });
});

describe("POST /account/notifications/:id/read (inbox mark-read)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("marks the thread read and redirects home", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    let markedStatus: string | null = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/notifications/threads/7", () =>
          Response.json({
            id: 7,
            repository: { full_name: "owner/w" },
            subject: { type: "Issue", title: "Bug", url: "http://forgejo.test/api/v1/repos/owner/w/issues/4" },
            updated_at: "2026-06-01T00:00:00Z",
          }),
        );
        forge.patch("/api/v1/notifications/threads/:id", (c) => {
          markedStatus = c.req.query("to-status") ?? null;
          return c.body(null, 205 as 200);
        });
      }),
    );

    const res = await appFor(db).request("/account/notifications/7/read", form({}, token));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(markedStatus).toBe("read");
  });

  it("honors safe next redirects after marking a thread read", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/notifications/threads/7", () =>
          Response.json({
            id: 7,
            repository: { full_name: "owner/w" },
            subject: { type: "Issue", title: "Bug", url: "http://forgejo.test/api/v1/repos/owner/w/issues/4" },
            updated_at: "2026-06-01T00:00:00Z",
          }),
        );
        forge.patch("/api/v1/notifications/threads/:id", (c) => c.body(null, 205 as 200));
      }),
    );

    const res = await appFor(db).request(
      "/account/notifications/7/read",
      form({ next: "/account/notifications" }, token),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/notifications");
  });

  it("rejects invalid notification ids without calling Forgejo", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(fakeForgejo(() => {}));

    const res = await appFor(db).request("/account/notifications/not-a-number/read", form({}, token));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid notification");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not mark stale notification threads as read", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/notifications/threads/7", () => new Response("not found", { status: 404 }));
        forge.patch("/api/v1/notifications/threads/:id", () => {
          throw new Error("must not mark stale notification");
        });
      }),
    );

    const res = await appFor(db).request("/account/notifications/7/read", form({}, token));

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Notification not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces Forgejo failures instead of redirecting as mark-read success", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/notifications/threads/7", () =>
          Response.json({
            id: 7,
            repository: { full_name: "owner/w" },
            subject: { type: "Issue", title: "Bug", url: "http://forgejo.test/api/v1/repos/owner/w/issues/4" },
            updated_at: "2026-06-01T00:00:00Z",
          }),
        );
        forge.patch("/api/v1/notifications/threads/:id", () => new Response("down", { status: 503 }));
      }),
    );

    const res = await appFor(db).request("/account/notifications/7/read", form({}, token));

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("backing forge failed");
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects to login when unauthenticated", async () => {
    const db = freshTestDb("cosheaf-account-");
    const res = await appFor(db).request("/account/notifications/7/read", form({}));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("POST /account/notifications/read-all (inbox bulk mark-read)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("marks all unread notifications read and redirects to a safe next path", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    let statusTypes: string | null = null;
    let toStatus: string | null = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.put("/api/v1/notifications", (c) => {
          const query = new URL(c.req.url).searchParams;
          statusTypes = query.get("status-types");
          toStatus = query.get("to-status");
          return c.body(null, 205 as 200);
        });
      }),
    );

    const res = await appFor(db).request(
      "/account/notifications/read-all",
      form({ next: "/account/notifications" }, token),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/notifications");
    expect(statusTypes).toBe("unread");
    expect(toStatus).toBe("read");
  });

  it("falls back home for unsafe next redirects", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.put("/api/v1/notifications", (c) => c.body(null, 205 as 200));
      }),
    );

    const res = await appFor(db).request(
      "/account/notifications/read-all",
      form({ next: "//evil.test" }, token),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("surfaces Forgejo failures instead of redirecting as read-all success", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.put("/api/v1/notifications", () => new Response("down", { status: 503 }));
      }),
    );

    const res = await appFor(db).request("/account/notifications/read-all", form({}, token));

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("backing forge failed");
    expect(res.headers.get("location")).toBeNull();
  });
});
