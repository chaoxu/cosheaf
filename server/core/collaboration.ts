import type { CollaborationClient } from "../collaboration-client.js";
import type { Forgejo } from "../forgejo.js";
import { forgeBranchToRow, forgeNotificationThreadToRow, forgeNotificationThreadsToRows } from "./forge-dto.js";

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
      if (prop === "listBranches") {
        return async (...args: Parameters<Forgejo["listBranches"]>) =>
          (await target.listBranches(...args)).map(forgeBranchToRow);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as CollaborationClient;
}
