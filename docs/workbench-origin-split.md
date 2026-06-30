# Workbench / Server Authority Split

This document names the workbench/server split before behavior changes land.
It is a migration contract for keeping local authoring useful without turning
Cosheaf Workbench into a second server or a local Forgejo clone.

## Terms

- **Cosheaf server**: the hosted authority for repository collaboration. It
  exposes typed Cosheaf APIs, owns collaboration policy, and delegates durable
  storage to the backing Forgejo service.
- **Origin API**: the typed API contract a workbench uses to talk to one
  Cosheaf server. "Origin" is an internal protocol term, not user-facing UI
  copy.
- **Hosted workbench**: the server-rendered web surface hosted by a Cosheaf
  server for a workspace repository.
- **Local workbench**: the local authoring shell that opens on-disk folders,
  writes local files and git commits, and may proxy collaboration views through
  an Origin API.
- **Workspace provider**: the implementation behind workspace content
  operations. Today this is either the hosted server's backend provider or the
  local git provider.

## Current Mapping

- The hosted web app is the Cosheaf server surface. Its durable repository
  concepts are branches, pull requests, issues, reviews, labels, milestones,
  notifications, and merges.
- The local workbench mode is the local authoring surface. It owns the opened
  folder, working tree state, local branches, commits, rendering, indexing, and
  local git authorship fallback.
- Typed `/api/v1/repos/:owner/:repo/*` routes are the public contract for
  clients, page islands, and future Origin API calls. They are not raw Forgejo
  passthrough routes.
- `server/local/**` and `LocalGitWorkspaceBackend` are the local git provider
  path. They must stay forge-free and must not import hosted forge clients.

## Authority Rules

- Collaboration state is server-owned: pull requests, issues, reviews, merge
  gates, notifications, collaborator permissions, labels, and milestones come
  from the Cosheaf server and its backing forge.
- Git working state may be local: file edits, uncommitted changes, branch
  checkout, commits, local diffs, and offline rendering belong to the local
  workbench.
- Local workbench code may display server collaboration views only by calling a
  configured Origin API. It must not persist local issues, local pull requests,
  local review state, merge state, notifications, labels, milestones, or
  permission caches as durable truth.
- SQLite sidecars are caches or local coordination state unless a table has an
  explicit server-side source of truth. Rebuildable state must remain
  rebuildable from the owning authority.
- Opening a pull request from the local workbench is a publish action: local
  git state is pushed or translated into a server branch, then the server owns
  the PR lifecycle.

### Issue Claims

`issue_claims` are local advisory coordination leases. They are stored in the
SQLite sidecar to help automation attached to one Cosheaf server process avoid
duplicating work for a short TTL, but they are not Forgejo issues, not Origin
API authority, and not durable collaboration state.

- A claim is meaningful only within the Cosheaf server process and workspace
  sidecar that created it.
- Claims may be dropped, expired, or rebuilt away without changing issue state.
- Cross-workbench or cross-server coordination must use a server-owned typed
  contract before it can rely on claim semantics.
- UI and API copy should describe claims as advisory live-work leases, not as
  ownership, assignment, locking, or review authority.

## User-Facing Naming

Avoid "origin" in visible product copy when it can collide with Git's `origin`
remote. Prefer:

- "Cosheaf server" for the hosted authority.
- "workspace server" for the configured server behind a specific folder.
- "remote collaboration" for PRs, issues, reviews, merge gates, and
  notifications.
- "local git state" or "local branch" for working tree and commit state.

Use "Origin API", `origin_id`, and origin-scoped identifiers only in internal
protocols, storage keys, code, and design docs where the multi-server meaning
matters.

## Multi-Server Model

Multi-server workbench mode is client-side composition, not a distributed
Cosheaf authority.

- A local workbench may be configured with multiple Cosheaf servers.
- Every server-backed object in local workbench state must be scoped by
  `origin_id` before it can coexist with another server's objects.
- `origin_id` identifies the configured Cosheaf server binding, not a git
  remote name and not a repository owner.
- Cross-server aggregate views may combine lists client-side, but actions must
  route back to the owning `origin_id`.
- No issue, pull request, review, notification, permission, label, or milestone
  object is globally meaningful without its `origin_id` and workspace identity.

## Security Rules

- Cross-server calls use bearer tokens scoped to the target Cosheaf server.
- Same-origin hosted web pages may use HttpOnly cookies; cross-origin Origin API
  calls must not rely on cookies.
- Raw Forgejo PATs must not be stored in workbench client state or sent by
  workbench clients. Cosheaf tokens stay opaque to clients; the Cosheaf server
  owns backend forge credentials.
- Local workbench HTTP service stays loopback-only by default. It has ambient
  local file authority and must reject cross-origin cookie-style mutations.
- A configured workspace server binding must make the target server and
  workspace visible enough that publishing a PR cannot silently go to the wrong
  server.
- Credential storage must be scoped by both `origin_id` and workspace where
  practical; never assume a single global server token in multi-server code.

## Migration Rules

- Add server collaboration behavior behind typed Cosheaf APIs or an internal
  Origin API client, not raw Forgejo routes.
- Keep local content operations behind `WorkspaceBackend` and
  `LocalGitWorkspaceBackend`; keep remote collaboration operations behind the
  remote client boundary.
- Any local persistence for server-backed objects must include `origin_id` or
  be blocked until the storage shape can be scoped safely.
- UI copy should distinguish remote collaboration state from local git state.
- Migration gates should prevent new Forgejo imports under `server/local/**`
  and should catch unscoped workbench persistence before multi-server behavior
  ships.

## Non-Goals

- No distributed issue system.
- No local pull-request authority.
- No local review or merge authority.
- No web UI rewrite as part of this split.
- No raw Forgejo passthrough contract for agents or workbench clients.
- No local server stack requirement for normal Workbench users.
