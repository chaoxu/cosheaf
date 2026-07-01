# Cosheaf Client / Server Design

This document records the product and architecture vocabulary Cosheaf should
converge on. The goal is to stop treating "local Cosheaf" and "hosted Cosheaf"
as two peer products. Cosheaf has one authority layer and multiple clients.

## Names

- **Core Server**: the shared authority. It owns identity, repositories,
  permissions, issues, pull requests, reviews, labels, milestones,
  notifications, publishing, server-backed content access, and typed APIs.
- **Workbench**: the local authoring client. It owns the user's local folders,
  local git state, editor sessions, private drafts, offline rendering, and
  local credentials. It talks to one or more Core Servers for shared state.
- **Hub**: the web UI served by a Core Server. It is the shared server
  perspective: canonical links, other people's work, public pages, review and
  admin fallback, onboarding, and zero-install access.
- **Client**: any consumer of the Core Server contract. Workbench, Hub, CLI,
  agents, and provers are all clients.

Use **Core Server**, **Workbench**, and **Hub** in product/design copy. Keep
`origin`, `origin_id`, and Origin API language for internal protocol/storage
details where the multi-server binding matters.

## Product Frame

Workbench is my working context. Hub is the shared server context. Core Server
is the authority.

Workbench and Hub are UI layers. They should differ by purpose and capabilities,
not by owning different truth. Collaboration, permissions, publishing, and
server-backed content access belong to Core Server.

The Hub exists because the server needs a zero-install, shared-perspective web
view. Its strongest unique capability is showing the Core Server's state as
other collaborators see it: other people's branches, pull requests, issues,
reviews, public pages, and canonical URLs. It is not a separate collaboration
authority and does not need to compete with Workbench as the primary authoring
surface.

## Deployment Shapes

The same app route/rendering modules should be composed with different
providers:

| Shape | Content | Core access | User model |
| --- | --- | --- | --- |
| Workbench connected | local folder / local git | remote Core Server API | single user per instance |
| Workbench bare | local folder / local git | none | single user per instance |
| Hub | server-backed repository content | in-process Core service/API | multi-user Core auth |
| CLI / agents | none or task-specific file IO | remote Core Server API | token-auth client |

Workbench is single-user per instance, not single-user per machine. On a shared
SSH machine, each Unix user should run their own Workbench instance with their
own folders, registry, Core tokens, git identity, port/socket, and data/cache
directory. A local Workbench has ambient authority over local files, so making
one instance multi-user would require a server-grade auth and filesystem
isolation model. That belongs to Core Server and Hub, not the local Workbench
preset.

## One App, Provider Bindings

The implementation target is one app composition model:

```ts
createCosheafApp({
  clientKind: "workbench" | "hub",
  contentBackend,
  coreClient,
  authProvider,
  capabilityManifest,
});
```

Most route and rendering code should be shared between Workbench and Hub:

- repository home
- file tree and file reader
- editor shell when content writes are available
- issues, pull requests, reviews, and timelines
- activity and notifications
- settings fragments
- search and diagnostics

Differences should be expressed as provider bindings and capabilities:

- `canReadContent`
- `canWriteContent`
- `canCommitLocally`
- `canOpenPull`
- `canReview`
- `canMerge`
- `canAdminRepo`
- `canServePublicPages`
- `canBrowseServerRepos`
- `canUseLocalFilesystem`

Prefer capability checks over mode checks. A route should ask whether the
current binding can commit locally or has a Core client, not whether it is
"local" or "hosted". That keeps future shapes possible without adding another
app.

## Core Boundary

Workbench and Hub must not know Forgejo exists. They should consume Core DTOs
and typed operations, plus a content backend interface. Forgejo is an
implementation detail inside Core Server and the forge-backed content adapter.

Allowed direction:

```text
Workbench -> Core API
Hub       -> in-process Core service/API
CLI       -> Core API
agents    -> Core API

Core Server -> Forgejo
```

Avoid:

```text
Hub route -> Forgejo client -> Forgejo response fields
Workbench -> Forgejo API
client DTO -> fake Forgejo shape -> UI rendering
```

This is the architectural reason to migrate Hub routes off `ctx.fj` and onto a
Core DTO service. The UI clients should not import Forgejo types, construct
Forgejo paths, or depend on Forgejo response fields.

## Content Boundary

Content remains a provider binding:

- Workbench content is local folder / local git through `WorkspaceBackend`.
- Hub content is server-backed repository content through a Core/forge content
  backend.
- Agents and CLI may use Core content APIs or task-specific local IO depending
  on the workflow.

Workbench may own local files, uncommitted edits, local branches, commits, and
offline rendering. It may publish those changes to a Core Server. Once a pull
request, review, issue, label, milestone, notification, merge gate, or public
page exists as shared state, the Core Server owns it.

## Multiple Core Servers

A Workbench can connect different workspaces to different Core Servers:

```text
workspace A -> core_id: cosheaf.chaoxu.prof
workspace B -> core_id: alice.example.edu
workspace C -> no Core Server
```

Every server-backed object must carry its authority:

```text
core_id + owner + repo + issue_number
core_id + owner + repo + pull_number
core_id + owner + repo + path + ref
```

Aggregate Workbench views may combine objects client-side, but every action must
route back to the owning Core Server. No issue, pull request, review,
notification, permission, label, or milestone object is globally meaningful
without its Core Server identity and workspace identity.

## Document Format

Cosheaf markdown is Coflat markdown. Clients should not carry a generic
Forgejo-Markdown product mode. Hub, Workbench, CLI, agents, and Core DTOs may
assume Coflat semantics for `.md` files.

If a repository marker remains useful, it should mark a repository as a
Cosheaf/Coflat workspace. It should not select among Markdown formats.

## Migration Invariants

- Core Server is the only authority for durable collaboration state.
- Workbench and Hub are clients, not authorities.
- Hub should call Core in-process when co-located, not loop back over HTTP.
- Workbench should call Core over a configured remote API connection.
- UI layers should not know Forgejo exists.
- Route/rendering modules should be shared by Workbench and Hub where practical.
- Differences should be capabilities and providers, not divergent app forks.
- Workbench remains single-user per instance.
- Hub is the zero-install shared server perspective, not a second full product.
