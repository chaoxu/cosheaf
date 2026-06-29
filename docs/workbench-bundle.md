# Cosheaf Workbench — consumer bundle

The local Workbench (`pnpm workbench <dir>`) can be packed into a self-contained,
plain-Node distributable so a **consumer** machine (e.g. `earth`) runs it with
only `node` — no repo, no pnpm, no sibling `../coflat`, no build step.

Develop on **saturn** (Mac dev box); ship the built bundle to the consumer. The
bundle is a plain-Node tarball, not a container: the Workbench opens arbitrary
local folders and pushes via the user's own git/SSH across many working trees, all
of which a container fights.

## Build the bundle (saturn)

```bash
pnpm workbench:pack          # → dist-workbench/ and cosheaf-workbench.tar.gz
pnpm workbench:pack --skip-build   # reuse an existing dist/ + dist-server/
```

`scripts/pack-workbench.mjs`:

- builds the islands (`pnpm build`) and server (`pnpm build:server`);
- resolves a **portable** prod `node_modules` (hoisted, real files — see the
  Dockerfile prod-deps recipe it mirrors), with `file:../coflat` copied in;
- rebuilds `better-sqlite3`'s native addon **in the bundle** (so the `.node`
  lands where `bindings` looks);
- vendors the pinned coflat `dist/` under `vendor/coflat/` (served via
  `COSHEAF_APP_ROOT`, so it works even if `node_modules` coflat is unavailable);
- writes the `cosheaf-workbench` shim (sets `COSHEAF_APP_ROOT`, honors
  `COSHEAF_CA_FILE`) and a consumer README, then tars it.

### Constraints

- **CPU arch:** the `better-sqlite3` `.node` is native. saturn and earth are both
  Apple Silicon (arm64), so one build serves both. Build per-arch otherwise.
- **Node major:** the addon is built against the packing machine's Node ABI. The
  consumer needs a compatible Node major (build and run with the same, e.g. 24).
- **Sidecar gitignore guard stays intact:** each `<folder>/.cosheaf/` is ignored,
  so `remote.json` tokens never get committed.

## Distribute to the consumer (earth)

The consumer needs **Node installed** (`brew install node`, nvm, etc.) — the
bundle ships everything else.

### Option A — direct copy

```bash
scp cosheaf-workbench.tar.gz earth:~/
ssh earth 'mkdir -p ~/cosheaf-workbench && tar -xzf ~/cosheaf-workbench.tar.gz -C ~/cosheaf-workbench --strip-components=1'
ssh earth '~/cosheaf-workbench/cosheaf-workbench ~/some/folder'
```

### Option B — Gitea release asset (no saturn online)

```bash
pnpm workbench:release         # packs + uploads the tarball to chaoxu/cosheaf
# on earth:
tea releases download workbench-<tag> --repo chaoxu/cosheaf -l coflat
tar -xzf cosheaf-workbench.tar.gz -C ~/cosheaf-workbench --strip-components=1
~/cosheaf-workbench/cosheaf-workbench ~/some/folder
```

`scripts/release-workbench.mjs` tags `workbench-<timestamp>` (or `--tag`) and
attaches the tarball as a release asset.

## Run

```bash
./cosheaf-workbench /path/to/your/folder
```

Opens a loopback server + your browser. Edits save to disk; commit and (with a
configured remote) open-PR are explicit UI actions.

### Reaching an internal-CA host over HTTPS (staging cosheaf-test.lab)

Node rejects the lab Caddy root by default
(`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`). Point it at the CA bundle — the shim
exports `NODE_EXTRA_CA_CERTS` from `COSHEAF_CA_FILE` **before** node starts (the
only place it takes effect):

```bash
COSHEAF_CA_FILE=~/.cosheaf/lab-root.pem ./cosheaf-workbench /path/to/folder
```

For `pnpm workbench` (dev, no shim) export `NODE_EXTRA_CA_CERTS` yourself. The
plain-HTTP tailnet endpoint needs no CA.
