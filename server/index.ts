import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AppEnv } from "./types.js";
import { getDb, loadConfig } from "./db.js";
import { auth } from "./routes/auth.js";
import { workspaces } from "./routes/workspaces.js";
import { notes } from "./routes/notes.js";
import { tokens } from "./routes/tokens.js";
import { workflow } from "./routes/workflow.js";

const config = loadConfig();
const db = getDb(config);

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("db", db);
  c.set("config", config);
  await next();
});

app.get("/api/v1/health", (c) => c.json({ ok: true }));

app.route("/api/v1", auth);
app.route("/api/v1/tokens", tokens);
app.route("/api/v1/workspaces", workspaces);
app.route("/api/v1/w", notes);
app.route("/api/v1/w", workflow);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`cosheaf server listening on http://localhost:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});
