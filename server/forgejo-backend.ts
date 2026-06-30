// Hosted implementation of WorkspaceBackend, backed by the Forgejo REST client.
//
// This is the ONLY module (besides the Forgejo client itself and the hosted
// review API it still serves directly) that translates between Forgejo shapes
// and the Cosheaf-native WorkspaceBackend seam. It returns the Forgejo response
// objects directly where they are structural supersets of the `Ws*` DTOs, and
// maps `ForgejoError` onto `WorkspaceBackendError` so route code branches on the
// native error code instead of a forge error body.

import { Forgejo, ForgejoError } from "./forgejo.js";
import {
  type WorkspaceBackend,
  WorkspaceBackendError,
  type WsBranch,
  type WsCommit,
  type WsCreateBranch,
  type WsDeleteFile,
  type WsFileMeta,
  type WsFileWrite,
  type WsPull,
  type WsPutFile,
  type WsPutFileBytes,
  type WsRepo,
  type WsTreeEntry,
} from "./workspace-backend.js";

// Translate a Forgejo error into the native classified error. Non-Forgejo
// failures (network/DNS) pass through untouched so a dead backend still throws.
function toWorkspaceBackendError(err: unknown): unknown {
  if (!(err instanceof ForgejoError)) return err;
  let code = "error";
  if (err.status === 404) code = "not_found";
  // A 409, or a 422 the forge tags "sha does not match", is a lost head race —
  // the same classification the old isStaleShaConflict applied.
  else if (err.status === 409) code = "stale_sha";
  else if (err.status === 422 && /sha does not match/i.test(err.bodyText)) code = "stale_sha";
  else if (err.status === 400 && /sha not found/i.test(err.bodyText)) code = "ref_missing";
  else if (err.status === 422) code = "unprocessable";
  return new WorkspaceBackendError(err.status, code, err.message);
}

async function tx<T>(thunk: () => Promise<T>): Promise<T> {
  try {
    return await thunk();
  } catch (err) {
    throw toWorkspaceBackendError(err);
  }
}

export class ForgejoWorkspaceBackend implements WorkspaceBackend {
  constructor(private fj: Forgejo) {}

  getTree(owner: string, repo: string, ref: string, recursive = true): Promise<WsTreeEntry[]> {
    return tx(() => this.fj.getTree(owner, repo, ref, recursive));
  }

  getRawFile(owner: string, repo: string, ref: string, filepath: string): Promise<string> {
    return tx(() => this.fj.getRawFile(owner, repo, ref, filepath));
  }

  getRawFileBytes(owner: string, repo: string, ref: string, filepath: string): Promise<Buffer> {
    return tx(() => this.fj.getRawFileBytes(owner, repo, ref, filepath));
  }

  getFileMeta(owner: string, repo: string, ref: string, filepath: string): Promise<WsFileMeta | null> {
    return tx(() => this.fj.getFileMeta(owner, repo, ref, filepath));
  }

  putFile(owner: string, repo: string, opts: WsPutFile): Promise<WsFileWrite> {
    return tx(() => this.fj.putFile(owner, repo, opts));
  }

  putFileBytes(owner: string, repo: string, opts: WsPutFileBytes): Promise<WsFileWrite> {
    return tx(() => this.fj.putFileBytes(owner, repo, opts));
  }

  deleteFile(owner: string, repo: string, opts: WsDeleteFile): Promise<void> {
    return tx(() => this.fj.deleteFile(owner, repo, opts));
  }

  getBranch(owner: string, repo: string, branch: string): Promise<WsBranch | null> {
    return tx(() => this.fj.getBranch(owner, repo, branch));
  }

  listBranches(owner: string, repo: string): Promise<WsBranch[]> {
    return tx(() => this.fj.listBranches(owner, repo));
  }

  createBranch(owner: string, repo: string, opts: WsCreateBranch): Promise<WsBranch> {
    return tx(() => this.fj.createBranch(owner, repo, opts));
  }

  deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    return tx(() => this.fj.deleteBranch(owner, repo, branch));
  }

  getRepo(owner: string, repo: string): Promise<WsRepo | null> {
    return tx(() => this.fj.getRepo(owner, repo));
  }

  listPulls(owner: string, repo: string, state: "open" | "closed" | "all"): Promise<WsPull[]> {
    return tx(() => this.fj.listPulls(owner, repo, state));
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<WsCommit | null> {
    try {
      const c = await this.fj.getCommit(owner, repo, sha);
      return {
        sha: c.sha,
        message: c.commit.message,
        author_name: c.commit.author?.name,
        author_login: c.author?.login,
        date: c.commit.author?.date,
      };
    } catch (err) {
      const mapped = toWorkspaceBackendError(err);
      if (mapped instanceof WorkspaceBackendError && mapped.code === "not_found") return null;
      throw mapped;
    }
  }
}
