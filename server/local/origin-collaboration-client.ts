// The local Workbench's CollaborationClient (#262/#263): implements the same
// surface the collaboration routes call, but sourced from the connected core's
// typed Cosheaf API (the Origin API) instead of a co-located Forgejo. This is
// the "local" half of the seam — hosted uses the Forgejo client directly.
//
// A workspace with no connected core has no collaboration source; the migrated
// routes render a Connect prompt rather than throwing. `localCollaborationClient`
// returns either an OriginCollaborationClient (connected) or that sentinel.

import type { CollaborationClient } from "../collaboration-client.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

// True when no core is connected for this workspace; the migrated collaboration
// routes branch on this to show the Connect form instead of data.
export class NoCoreConnectedError extends Error {
  constructor() {
    super("No Cosheaf server connected for this workspace.");
    this.name = "NoCoreConnectedError";
  }
}

// Placeholder until OriginCollaborationClient is implemented (#263). Throws
// NoCoreConnectedError for every method so the type is satisfied and any
// accidental use is loud; no collaboration route is mounted in local mode yet,
// so this is never reached at runtime.
function unconnectedClient(): CollaborationClient {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new NoCoreConnectedError();
        };
      },
    },
  ) as CollaborationClient;
}

// The collaboration source for a local workspace: the connected core via the
// Origin API, or the unconnected sentinel.
export function localCollaborationClient(_entry: WorkspaceEntry): CollaborationClient {
  // TODO(#263): when entry.remote is configured, return a real
  // OriginCollaborationClient bound to entry.remote.{url,token}.
  return unconnectedClient();
}
