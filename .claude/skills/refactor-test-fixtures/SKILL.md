---
name: refactor-test-fixtures
description: Sweep test fixtures across the cosheaf test suite after a server refactor. Dispatches a focused subagent to update fixture shapes (renamed columns, renamed interfaces, dropped tables), then verifies typecheck + vitest pass. Use when a server change has rippled into test files and you'd rather not babysit the search-and-replace.
---

# Refactor test fixtures

After a server-side rename or schema change, the vitest suite typically needs
dozens of small mechanical edits across `server/**/*.test.ts` and
`server/routes/test-fixtures.ts`. Doing them inline burns your context on
search-and-replace. This skill dispatches that work to a subagent.

## When to use

Trigger this skill when the parent task is "I just changed X on the server,
update the tests" and X is mechanical:

- Renamed a SQL column (e.g. `workspace_id` → `workspace_slug`).
- Renamed a TypeScript interface field (e.g. `PageIngest.workspaceId` → `workspaceSlug`).
- Dropped a table or column and tests still seed it.
- Replaced cookie-based test auth with bearer-based test auth.
- Changed a function signature that's called from many test files.

Don't use it for tests whose *semantics* changed — those need real thought.

## How to use

1. **Make the server change first.** The subagent needs a stable target.
   Production code (everything outside `server/**/*.test.ts` and
   `tests/**`) should typecheck before you dispatch.

2. **Identify the affected files yourself.** A quick `grep -rln <old-name>
   server/ tests/` is enough — the subagent works better with a list than
   with "search the codebase".

3. **Dispatch with a precise prompt.** Use the template below.

4. **Verify.** When the agent reports done, run:
   ```
   pnpm typecheck:server && pnpm test -- --run
   ```
   If anything's red, send a follow-up via SendMessage to the same agent;
   don't re-spawn.

## Prompt template

```
You're updating test files in the cosheaf repo at /Users/chaoxu/playground/cosheaf
after a refactor that just landed in main source files. The refactor:

<1-line summary>

Concrete changes:
1. <Field / column / function rename or removal — exactly what it was
   before, exactly what it is now.>
2. <New helper if any — name, import path, signature.>
3. <Behavior gates that may need test updates: new TTL caches to seed,
   new Forgejo endpoints to mock, etc.>

Test files to update:
<paste the grep -rln output>

For each file, make the minimal edits to compile + pass:
- Rename fields/columns at every callsite.
- Update mock returns when a new endpoint is consumed.
- Drop test cases that asserted on dropped behavior (don't repurpose
  them — delete cleanly).
- Don't rewrite tests beyond what the refactor requires.

Conventions:
- `.js` suffix on relative imports (NodeNext).
- snake_case at SQL + JSON wire shape; camelCase in TS types.
- No bare `catch {}`.

When done, run `pnpm typecheck:server` and `pnpm test -- --run` from the
repo root. Iterate until green. Report under 200 words: what you changed
and any tests you couldn't fix.
```

## Notes

- The subagent does not have your conversation context. The prompt must
  list the renames concretely — paths, before/after names, the new helper
  signatures. Don't say "as discussed."
- If a test fails for a real semantic reason (the refactor broke behavior,
  not fixture shape), the subagent will surface it — read its report
  carefully before assuming it gave up.
- For very large sweeps (>15 files), prefer two narrower dispatches over
  one mega-prompt. The agent's editing accuracy degrades on long
  to-do lists.
