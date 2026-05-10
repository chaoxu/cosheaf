# Handoff: Forgejo backend pivot

You're picking up an architectural rewrite of Cosheaf's server layer. The goal is to replace `server/`'s internals with an adapter that uses **vanilla Forgejo** as the backing store for canonical content, change history, and workflow primitives. The frontend, the public HTTP API, and the autoprover client all stay the same.

**The complete technical specification is in cosheaf issue #7.** Read it before doing anything else.

This handoff document gives you the orientation that's not in the issue: project context, what NOT to touch, and how to validate.

---

## Project at a glance

Cosheaf is a math knowledge base. It's used by:

- **Humans** writing math via a Vite/React frontend (in `src/`) with a Coflat editor.
- **Autoprover** (a sibling Python CLI in `../autoprover/`), which runs LLM agents that explore, propose, repair, and review math documents.

The current server (`server/`) is a Hono app with sqlite + filesystem storage. It implements its own workflow state machine: documents transition through `draft → unreviewed → {golden, rejected}`, with `proposal` and `review` document types attached to approval rows.

The project's vocabulary (page, proposal, review, comment, issue) is being mapped onto GitHub-style entities (file, PR, PullReview, comment, issue). Forgejo is the GitHub-clone open-source forge we're using as the backing store.

**v0 of autoprover already works against the current Cosheaf.** This pivot is so the system scales (multi-file atomic updates, free webhooks for event-driven daemon, mature workflow code instead of ours, free git history and mirroring, free OAuth machinery).

---

## What you must NOT change

These are non-negotiable. Verify each is preserved before marking the work done.

### 1. The frontend (`src/`)

The Vite/React app, including the Coflat editor and renderer, stays exactly as-is. You don't touch any file under `src/`. If something breaks in the frontend after your changes, the bug is in your adapter, not in the frontend.

### 2. The public HTTP API contract (under `/api/v1/`)

Every endpoint that exists today must keep:

- Same path
- Same HTTP method
- Same request body shape
- Same response body shape (down to field names, types, and shape)
- Same error codes (e.g. `code: "validation"`, `code: "conflict"`, `code: "not_found"`)

The frontend and autoprover both depend on this contract. **Test with both clients** as part of validation.

To enumerate current endpoints: `grep -rEn '\.(get|post|put|delete|patch)\(' server/routes/`. The issue #7 has a complete mapping table — every endpoint listed there must continue to work.

### 3. Autoprover's client (`../autoprover/src/autoprover/cosheaf.py`)

Zero changes. Its method signatures and the wire calls they make must keep working byte-identically. This client is the strongest test of the API contract: if every autoprover test passes against your new server, the contract is preserved.

### 4. Coflat byte-exactness

`PUT /note?path=X` followed by `GET /note?path=X` must return the exact same bytes. Forgejo guarantees this on its end (verified in issue #7 references); your adapter must not mangle bytes either. Watch for line-ending normalization (`.gitattributes` lock for `*.md` is in the spec).

### 5. The user/token model (mostly)

Cosheaf still owns user accounts and issues its own tokens. Don't migrate users into Forgejo as the auth source. Cosheaf-side authentication stays; the adapter holds a Forgejo admin token for backend calls.

---

## What you should change

Everything inside `server/`. The spec details what gets retired, what gets rewritten, what's new. In summary:

- Retire: `workflow.ts`, the document/approval sqlite schema, the `workspace dir` filesystem, `indexer.ts` (rewrite), `links.ts` (rewrite).
- Rewrite: every route handler in `server/routes/`. Same paths and shapes; new internals.
- Add: a Forgejo client wrapper, a webhook receiver, a sidecar FTS+backlinks+tags database.

The migration is a one-time script that takes existing Cosheaf data → Forgejo repos.

---

## Where to start

Read these files in order before writing any code:

1. **The issue itself**: cosheaf#7 (the complete spec).
2. **`server/routes/notes.ts`**: most of the file/content endpoints live here.
3. **`server/routes/workflow.ts`**: workflow endpoints (proposal, review, submit, approve, reject).
4. **`server/routes/workspaces.ts`**: workspace creation and listing.
5. **`server/workflow.ts`**: the state machine you're replacing. Understand what it does so you know what to translate.
6. **`server/indexer.ts`** and **`server/links.ts`**: current FTS and backlinks logic. The new versions will live in your sidecar.
7. **`../autoprover/src/autoprover/cosheaf.py`**: the client. Each method tells you exactly what API surface you must preserve.
8. **`../autoprover/scripts/smoke-cosheaf`**: end-to-end integration test. Reading this tells you the canonical happy + reject paths.

Then look at the **Forgejo API spec**:

- Live: `https://codeberg.org/swagger.v1.json` (314 endpoints, all documented).
- Browse it: `https://codeberg.org/api/swagger`.

The endpoints you'll use most: `/repos/{owner}/{repo}/contents/{filepath}`, `/repos/{owner}/{repo}/pulls`, `/repos/{owner}/{repo}/pulls/{index}/reviews`, `/repos/{owner}/{repo}/issues`, `/repos/{owner}/{repo}/branches`, `/repos/{owner}/{repo}/branch_protections`, `/repos/{owner}/{repo}/hooks`.

---

## How to validate as you go

### Per-endpoint validation (during development)

For each endpoint you migrate, write a small test that:

1. Spins up a fresh Forgejo instance (in-memory or temp dir).
2. Stands up your adapter against it.
3. Exercises the endpoint with a known request.
4. Verifies the response shape matches the current implementation byte-for-byte.

You can extract the "current implementation's response shape" by hitting the existing Cosheaf server with the same input.

### Integration validation (when most of the adapter is built)

```sh
# In autoprover repo
cd ../autoprover
./scripts/check                  # all 49 unit tests pass
./scripts/smoke-cosheaf          # happy path + reject-then-repair path,
                                 # against your new Cosheaf adapter
```

`smoke-cosheaf` is the canonical end-to-end test. If it passes, the adapter preserves the contract well enough for autoprover.

### Frontend validation (final)

```sh
# In cosheaf repo
pnpm build                       # frontend must still build
pnpm dev                         # frontend must still run
# manually click through: list workspaces, open a doc, edit, submit, review
```

---

## When you're done

Validation criteria from the issue:

1. All 49 autoprover tests pass.
2. `scripts/smoke-cosheaf` passes (both happy and reject paths).
3. `scripts/check-verifier-safety` runs to completion with a real verifier.
4. Manual `autoprover cycle` test produces a PR in Forgejo's UI.
5. Coflat byte-exact round-trip verified.
6. Frontend builds and runs unchanged.

When all six are green, stop. Don't expand scope to UX improvements, performance work, or new features — those are separate issues.

---

## Pitfalls flagged in advance

1. **Don't store doc state in Forgejo's frontmatter**. Forgejo doesn't know about it; you'd be relying on Forgejo not modifying YAML frontmatter (it doesn't, but the contract isn't there). State that depends on workflow lives in the sidecar's `doc_map` table.

2. **Branches must not auto-delete on PR close**. Configure each repo so closed PRs preserve their branches; we use them as forensic evidence of rejected attempts. Spec details a `refs/rejected/{n}` convention.

3. **Cosheaf doc ids must be stable across sidecar rebuilds**. Persist them in page frontmatter (the spec recommends this).

4. **The autoprover client uses Cosheaf doc ids, not PR numbers**. Don't leak Forgejo internals (PR numbers, commit SHAs) through the public API; map everything through the sidecar's `doc_map`.

5. **`smoke-cosheaf` invokes a Cosheaf instance via the `pnpm cli` admin tooling**. Make sure your CLI handlers (`server/cli.ts`) keep working post-pivot — they're how workspaces and users get seeded for tests.

6. **Webhooks must be idempotent**. Forgejo will redeliver on failure. Each handler must handle the same event arriving twice without breaking the sidecar.

7. **Don't break SSE events**. The frontend's "live updates" depend on `GET /events`. Implement webhook → SSE fan-out so frontends still see real-time updates.

---

## Working with autoprover during the pivot

Autoprover should keep running against the current Cosheaf during the pivot. Don't change autoprover's code. The way to test your new adapter is:

1. Run your new adapter on a different port (`COSHEAF_PORT=3031`).
2. Set autoprover's `COSHEAF_URL` to point at the new adapter.
3. Run autoprover commands and tests.
4. Compare behavior against the autoprover-on-old-Cosheaf baseline.

This means the pivot ships as a swap: when ready, point autoprover (and the frontend) at the new server, retire the old one, run the migration script.

---

## Summary

- Read cosheaf#7 first. It is the spec.
- Don't touch the frontend or autoprover client.
- Preserve the public API contract exactly.
- Build the adapter, validate at each step, run autoprover tests against it.
- Stop when the validation criteria are green.

If you hit a question the spec doesn't answer, prefer the option that minimizes change to anything outside `server/`. If you have to break the contract for a real reason, surface that as a comment on cosheaf#7 before doing it.
