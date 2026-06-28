import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { getDb, loadConfig } from "./db.js";
import { Forgejo } from "./forgejo.js";
import { startSidecarReconciler } from "./sidecar-reconciler.js";
import { SSEHub } from "./sse.js";

const config = loadConfig();
const db = getDb(config);
// Admin-bound Forgejo client. Used by the webhook handler (no user context)
// and explicit provisioning paths. Normal user-facing workspace routes use the
// server-side Forgejo credential resolved from the caller's opaque Cosheaf
// token; COSHEAF_FORGEJO_TOKEN is kept non-admin.
const fjAdmin = new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoAdminToken });
const sse = new SSEHub();
const app = createApp({ config, db, fjAdmin, sse });
startSidecarReconciler({
  db,
  forgejo: fjAdmin,
  intervalMs: config.reconcileIntervalMs,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`cosheaf server listening on http://localhost:${info.port}`);
  if (process.env.COSHEAF_DEBUG_BACKEND === "1") console.log(`forgejo: ${config.forgejoUrl}`);
  console.log(`data dir: ${config.dataDir}`);
  if (config.reconcileIntervalMs > 0) console.log(`sidecar reconcile interval: ${config.reconcileIntervalMs}ms`);
});
