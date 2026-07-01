import type { CollaborationClient } from "../collaboration-client.js";
import { resolveLineComment } from "../diff-position.js";
import type { Forgejo } from "../forgejo.js";
import { splitUnifiedDiff } from "../diff-splitter.js";
import {
  forgeBranchToRow,
  forgeCommitToPrCommit,
  forgeIssueCommentToDto,
  forgeIssueToDependencyRow,
  forgeIssueToDetail,
  forgeIssueToRow,
  forgeMilestoneToDto,
  forgeNotificationThreadToRow,
  forgeNotificationThreadsToRows,
  forgePullCommentToDto,
  forgePullFileToDto,
  forgePullToMeta,
  forgeReviewToDto,
  forgeTimelineEventToDto,
  toLabel,
} from "./forge-dto.js";

export function forgeCoreCollaborationClient(fj: Forgejo): CollaborationClient {
  return new Proxy(fj, {
    get(target, prop) {
      if (prop === "listIssues") {
        return async (...args: Parameters<Forgejo["listIssues"]>) =>
          (await target.listIssues(...args)).filter((issue) => !issue.pull_request).map(forgeIssueToRow);
      }
      if (prop === "getIssue") {
        return async (...args: Parameters<Forgejo["getIssue"]>) => {
          const issue = await target.getIssue(...args);
          if (issue.pull_request) {
            const err = new Error("issue not found") as Error & { status?: number };
            err.status = 404;
            throw err;
          }
          return forgeIssueToDetail(issue);
        };
      }
      if (prop === "createIssue") {
        return async (...args: Parameters<Forgejo["createIssue"]>) =>
          forgeIssueToDetail(await target.createIssue(...args));
      }
      if (prop === "editIssue") {
        return async (...args: Parameters<Forgejo["editIssue"]>) =>
          forgeIssueToDetail(await target.editIssue(...args));
      }
      if (prop === "listIssueComments") {
        return async (...args: Parameters<Forgejo["listIssueComments"]>) =>
          (await target.listIssueComments(...args)).map(forgeIssueCommentToDto);
      }
      if (prop === "createIssueComment") {
        return async (...args: Parameters<Forgejo["createIssueComment"]>) =>
          forgeIssueCommentToDto(await target.createIssueComment(...args));
      }
      if (prop === "editIssueComment") {
        return async (...args: Parameters<Forgejo["editIssueComment"]>) =>
          forgeIssueCommentToDto(await target.editIssueComment(...args));
      }
      if (prop === "listIssueTimeline") {
        return async (...args: Parameters<Forgejo["listIssueTimeline"]>) =>
          ((await target.listIssueTimeline(...args)) ?? []).map(forgeTimelineEventToDto);
      }
      if (prop === "listLabels") {
        return async (...args: Parameters<Forgejo["listLabels"]>) =>
          (await target.listLabels(...args)).map(toLabel);
      }
      if (prop === "createLabel") {
        return async (...args: Parameters<Forgejo["createLabel"]>) =>
          toLabel(await target.createLabel(...args));
      }
      if (prop === "editLabel") {
        return async (...args: Parameters<Forgejo["editLabel"]>) =>
          toLabel(await target.editLabel(...args));
      }
      if (prop === "setIssueLabels") {
        return async (...args: Parameters<Forgejo["setIssueLabels"]>) =>
          (await target.setIssueLabels(...args)).map(toLabel);
      }
      if (prop === "listMilestones") {
        return async (...args: Parameters<Forgejo["listMilestones"]>) =>
          (await target.listMilestones(...args)).map(forgeMilestoneToDto);
      }
      if (prop === "createMilestone") {
        return async (...args: Parameters<Forgejo["createMilestone"]>) =>
          forgeMilestoneToDto(await target.createMilestone(...args));
      }
      if (prop === "editMilestone") {
        return async (...args: Parameters<Forgejo["editMilestone"]>) =>
          forgeMilestoneToDto(await target.editMilestone(...args));
      }
      if (prop === "listPinnedIssues") {
        return async (...args: Parameters<Forgejo["listPinnedIssues"]>) =>
          (await target.listPinnedIssues(...args)).filter((issue) => !issue.pull_request).map(forgeIssueToRow);
      }
      if (prop === "listIssueDependencies") {
        return async (...args: Parameters<Forgejo["listIssueDependencies"]>) =>
          (await target.listIssueDependencies(...args)).map(forgeIssueToDependencyRow);
      }
      if (prop === "addIssueDependency") {
        return async (...args: Parameters<Forgejo["addIssueDependency"]>) =>
          forgeIssueToDependencyRow(await target.addIssueDependency(...args));
      }
      if (prop === "removeIssueDependency") {
        return async (...args: Parameters<Forgejo["removeIssueDependency"]>) =>
          forgeIssueToDependencyRow(await target.removeIssueDependency(...args));
      }
      if (prop === "listIssueBlocks") {
        return async (...args: Parameters<Forgejo["listIssueBlocks"]>) =>
          (await target.listIssueBlocks(...args)).map(forgeIssueToDependencyRow);
      }
      if (prop === "listPulls") {
        return async (...args: Parameters<Forgejo["listPulls"]>) =>
          (await target.listPulls(...args)).map(forgePullToMeta);
      }
      if (prop === "getPull") {
        return async (...args: Parameters<Forgejo["getPull"]>) => {
          const pull = await target.getPull(...args);
          return pull ? forgePullToMeta(pull) : null;
        };
      }
      if (prop === "createPull") {
        return async (...args: Parameters<Forgejo["createPull"]>) =>
          forgePullToMeta(await target.createPull(...args));
      }
      if (prop === "editPull") {
        return async (...args: Parameters<Forgejo["editPull"]>) =>
          forgePullToMeta(await target.editPull(...args));
      }
      if (prop === "listPullFiles") {
        return async (...args: Parameters<Forgejo["listPullFiles"]>) => {
          const [files, unified] = await Promise.all([
            target.listPullFiles(...args),
            target.getPullDiff(...args).catch(() => ""),
          ]);
          const patches = splitUnifiedDiff(unified);
          const byPath = new Map(patches.map((p) => [p.path, p]));
          return files.map((file) => forgePullFileToDto(file, byPath.get(file.filename)?.patch ?? ""));
        };
      }
      if (prop === "listPullCommits") {
        return async (...args: Parameters<Forgejo["listPullCommits"]>) =>
          (await target.listPullCommits(...args)).map(forgeCommitToPrCommit);
      }
      if (prop === "listPullComments") {
        return async (...args: Parameters<Forgejo["listPullComments"]>) => {
          const [comments, files] = await Promise.all([
            target.listPullComments(...args),
            target.listPullFiles(args[0], args[1], args[2]).catch(() => []),
          ]);
          const status = new Map(files.map((file) => [file.filename, file.status]));
          return comments.map((comment) =>
            forgePullCommentToDto(comment, resolveLineComment(comment, status.get(comment.path) ?? "")),
          );
        };
      }
      if (prop === "listReviews") {
        return async (...args: Parameters<Forgejo["listReviews"]>) =>
          (await target.listReviews(...args)).map(forgeReviewToDto);
      }
      if (prop === "createReview") {
        return async (...args: Parameters<Forgejo["createReview"]>) =>
          forgeReviewToDto(await target.createReview(...args));
      }
      if (prop === "submitPullReview") {
        return async (...args: Parameters<Forgejo["submitPullReview"]>) =>
          forgeReviewToDto(await target.submitPullReview(...args));
      }
      if (prop === "addCommentToReview") {
        return async (...args: Parameters<Forgejo["addCommentToReview"]>) =>
          forgePullCommentToDto(await target.addCommentToReview(...args), {
            line: args[4].new_position ?? args[4].old_position ?? null,
            side: args[4].new_position !== undefined ? "head" : "base",
            outdated: false,
          });
      }
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
