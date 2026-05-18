import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AppEnv } from "./types.js";
import { getDb, loadConfig } from "./db.js";
import { Forgejo, ForgejoError } from "./forgejo.js";
import { SSEHub } from "./sse.js";
import { auth } from "./routes/auth.js";
import { workspaces } from "./routes/workspaces.js";
import { files } from "./routes/files.js";
import { branches } from "./routes/branches.js";
import { pulls } from "./routes/pulls.js";
import { issues } from "./routes/issues.js";
import { notifications } from "./routes/notifications.js";
import { webhooks } from "./routes/webhooks.js";
import { forgejoPassthrough } from "./routes/forgejo-passthrough.js";

const config = loadConfig();
const db = getDb(config);
// Admin-bound Forgejo client. Used by the webhook handler (no user context)
// and out-of-band provisioning. Never reached on a user-facing request path —
// per-request middleware builds a Forgejo from the user's stored PAT instead.
const fjAdmin = new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoToken });
const sse = new SSEHub();

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("db", db);
  c.set("config", config);
  c.set("fjAdmin", fjAdmin);
  c.set("sse", sse);
  await next();
});

app.get("/api/v1/health", (c) => c.json({ ok: true }));

// If a route handler bubbles a ForgejoError with status 401 it means the
// caller's PAT was rejected by Forgejo (revoked, rotated). Surface a typed
// `pat_invalid` so the SPA can drop the stored PAT and bounce to login;
// agents see the same signal and re-acquire a PAT.
app.onError((err, c) => {
  if (err instanceof ForgejoError && err.status === 401) {
    return c.json(
      { error: "Forgejo rejected the credentials; please log in again.", code: "pat_invalid" },
      401,
    );
  }
  throw err;
});

app.route("/api/v1", auth);
app.route("/api/v1/workspaces", workspaces);
app.route("/api/v1/w", files);
app.route("/api/v1/w", pulls);
app.route("/api/v1/w", branches);
app.route("/api/v1/w", issues);
app.route("/api/v1/w", notifications);
app.route("/api/v1/w", forgejoPassthrough);
app.route("/api/v1/webhooks", webhooks);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`cosheaf server listening on http://localhost:${info.port}`);
  console.log(`forgejo: ${config.forgejoUrl} (owner=${config.forgejoOwner})`);
  console.log(`data dir: ${config.dataDir}`);
});
