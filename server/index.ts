import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AppEnv } from "./types.js";
import { getDb, loadConfig } from "./db.js";
import { auth } from "./routes/auth.js";
import { workspaces } from "./routes/workspaces.js";
import { notes } from "./routes/notes.js";
import { tokens } from "./routes/tokens.js";

const config = loadConfig();
const db = getDb(config);

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("db", db);
  c.set("config", config);
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api", auth);
app.route("/api/tokens", tokens);
app.route("/api/workspaces", workspaces);
app.route("/api/w", notes);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`cosheaf server listening on http://localhost:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});
