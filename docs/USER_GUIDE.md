# Cosheaf User Guide

Cosheaf is a focused interface for writing and reviewing Markdown knowledge
bases that live in Forgejo repositories. Use it like a repository, not like a
separate CMS: files are Markdown, unfinished work happens on branches, review
happens in pull requests, and merged content on `main` is canonical.

## Mental Model

- **Account**: your Cosheaf account is your Forgejo account. Your username,
  profile, repository access, SSH keys, and notifications come from the forge.
- **Workspace**: one Forgejo repository, addressed as `owner/repo`.
- **Page**: one Markdown file in a workspace.
- **Branch**: an isolated line of work for edits that are not ready to publish.
- **Pull request**: the durable review record for a branch.
- **Issue**: a durable discussion or task record.
- **Review**: an approval or change request on a pull request.
- **Agent**: a collaborator account that uses the same branch, pull request,
  issue, and review workflow as a person.

## Normal Workflow

1. Open a workspace from the home page.
2. Create or edit a Markdown page from Files.
3. Save the change on a branch.
4. Open a pull request when the branch is ready.
5. Ask a collaborator to review it.
6. Merge the pull request when the review state is acceptable.

The merge is the publication step. Search, backlinks, and document metadata
track the canonical `main` branch after webhook reconciliation or reindexing.

## What Is Durable?

Repository files, branches, pull requests, reviews, issues, comments, labels,
milestones, memberships, and notifications live in Forgejo. Cosheaf's SQLite
database is a rebuildable sidecar for search, backlinks, document metadata,
webhook dedupe, and browser login tokens.

If something must be permanent, put it in a Markdown file, issue, pull request,
review, or comment.

## Workspace Formats

Cosheaf supports plain Forgejo Markdown and Coflat-flavored Markdown.

- **Forgejo Markdown** is the default for ordinary repositories.
- **Coflat** adds math-friendly rendering, backlinks from `[@id]` references,
  richer review diffs, and stable page ids in YAML frontmatter.

The workspace format is selected by repository topics such as
`cosheaf-format-coflat`. Untagged repositories still appear in Cosheaf and use
Forgejo Markdown passthrough.

## Common Tasks

### Write a New Page

1. Open the workspace.
2. Go to Files.
3. Create a `.md` file or edit an existing one.
4. Save on a named branch.
5. Open a pull request for review.

### Review a Change

1. Open Pull requests.
2. Inspect the changed files in source or rich view.
3. Comment where wording, references, or math need work.
4. Approve or request changes.

### Find Related Knowledge

1. Search from the workspace files view.
2. Follow page references and backlinks.
3. Use issues when a missing page or unresolved question should become work.

### Invite Someone

1. Open repository Settings.
2. Grant repository access to their username.
3. Ask them to sign in and open the workspace.
4. Coordinate their first change through an issue or pull request.

## Agent Work

Agents use the same durable objects as people. They should create branches,
write files through Cosheaf's typed API, open pull requests, comment on issues,
and submit reviews. Do not rely on private local state for work that other
users need to see.

For API details, see [API.md](../API.md).
