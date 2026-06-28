// The chrome's notification poller (public/cosheaf-notifications.js) hits
// /api/v1/notifications and its SSE /events on every page. The local Workbench
// has no notifications, but it still serves the chrome — so answer empty rather
// than 404. Mounted only in local mode.

import { Hono } from "hono";
import { requireAuth } from "../middleware.js";
import { streamHubChannel } from "../routes/sse-helpers.js";
import type { AppEnv } from "../types.js";

export const localNotifications = new Hono<AppEnv>();
localNotifications.use("*", requireAuth);

localNotifications.get("/notifications", (c) => c.json([]));

// A live-but-silent SSE channel keeps the chrome's EventSource open (no 404,
// no reconnect storm); nothing ever publishes to it locally.
localNotifications.get("/notifications/events", (c) => streamHubChannel(c, c.get("sse"), "local:notifications"));
