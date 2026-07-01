import type { CollaborationClient } from "../collaboration-client.js";
import type { Forgejo } from "../forgejo.js";
import { forgeNotificationThreadToRow, forgeNotificationThreadsToRows } from "./forge-dto.js";

export function forgeCoreCollaborationClient(fj: Forgejo): CollaborationClient {
  return new Proxy(fj, {
    get(target, prop) {
      if (prop === "listRepoNotifications") {
        return async (...args: Parameters<Forgejo["listRepoNotifications"]>) =>
          forgeNotificationThreadsToRows(await target.listRepoNotifications(...args));
      }
      if (prop === "getNotificationThread") {
        return async (...args: Parameters<Forgejo["getNotificationThread"]>) =>
          forgeNotificationThreadToRow(await target.getNotificationThread(...args));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as CollaborationClient;
}
