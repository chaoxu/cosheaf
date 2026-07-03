# Cosheaf Document Format

Cosheaf does not own the Coflat syntax specification. Coflat workspaces use the
canonical Coflat document format:

- [Coflat](https://github.com/chaoxu/coflat)
- [Coflat `FORMAT.md`](https://github.com/chaoxu/coflat/blob/main/FORMAT.md)

Cosheaf is the Forgejo-backed host around that format. It adds repository,
branch, issue, pull-request, review, rendering, and indexing behavior, but it
should not duplicate Coflat's parser or syntax contract.

Do not add Coflat syntax rules to this file. Update Coflat's `FORMAT.md`
instead, then consume the updated Coflat package or checkout from Cosheaf.

## Cosheaf-Specific Behavior

- Markdown pages live as `.md` files in Forgejo branches.
- Cosheaf markdown is Coflat-only. Workspaces may carry the
  `cosheaf-format-coflat` Forgejo repo topic as a marker; obsolete format
  topics are ignored by runtime format resolution.
- Cosheaf renders files through `@chaoxu/coflat` and indexes Coflat references
  for backlinks and rich review diffs.
- YAML frontmatter is parsed by Cosheaf for stable page identity. The `id`
  field is the durable Cosheaf page id.
- Cosheaf indexes these page links:
  - `[@id]` Coflat/Pandoc-style references.
  - `[text](relative/path.md[#fragment])` Markdown links to pages.
- Markdown writes made through Cosheaf's typed file route update the sidecar
  index synchronously. External Forgejo edits are reconciled by webhooks or
  `pnpm cli workspace reindex <owner>/<repo>`.

## Related Repositories

- [Coflat](https://github.com/chaoxu/coflat) owns the document format, parser,
  reader, and editor package.
- [Coverify](https://github.com/chaoxu/coverify) is the separate agent/prover
  harness layer that talks to Cosheaf through the HTTP API.
