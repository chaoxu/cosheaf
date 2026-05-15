import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AppEnv } from "./types.js";
import { getDb, loadConfig } from "./db.js";
import { Forgejo } from "./forgejo.js";
import { SSEHub } from "./sse.js";
import { auth } from "./routes/auth.js";
import { tokens } from "./routes/tokens.js";
import { workspaces } from "./routes/workspaces.js";
import { files } from "./routes/files.js";
import { changes } from "./routes/changes.js";
import { issues } from "./routes/issues.js";
import { notifications } from "./routes/notifications.js";
import { webhooks } from "./routes/webhooks.js";

const config = loadConfig();
const db = getDb(config);
const forgejo = new Forgejo({ baseUrl: config.forgejoUrl, adminToken: config.forgejoToken });
const sse = new SSEHub();

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("db", db);
  c.set("config", config);
  c.set("forgejo", forgejo);
  c.set("sse", sse);
  await next();
});

app.get("/api/v1/health", (c) => c.json({ ok: true }));

app.route("/api/v1", auth);
app.route("/api/v1/tokens", tokens);
app.route("/api/v1/workspaces", workspaces);
app.route("/api/v1/w", files);
app.route("/api/v1/w", changes);
app.route("/api/v1/w", issues);
app.route("/api/v1/w", notifications);
app.route("/api/v1/webhooks", webhooks);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`cosheaf server listening on http://localhost:${info.port}`);
  console.log(`forgejo: ${config.forgejoUrl} (owner=${config.forgejoOwner})`);
  console.log(`data dir: ${config.dataDir}`);
});
