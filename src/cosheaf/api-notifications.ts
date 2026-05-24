import type { NotificationRow } from "../../shared/issues";
import { jsonFetch, workspaceApiPath as w } from "./api-core";

export const notificationApi = {
  listNotifications: (slug: string) =>
    jsonFetch<{ notifications: NotificationRow[] }>(`${w(slug)}/notifications`).then(
      (r) => r.notifications,
    ),
  markNotificationRead: (slug: string, id: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: (slug: string) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/notifications/read-all`, { method: "POST" }),
};
