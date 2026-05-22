import { createInterface } from "node:readline/promises";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import repl from "node:repl";
import { stdin, stdout } from "node:process";
import { Command, InvalidArgumentError } from "commander";
import { WORKSPACE_SLUG_RE } from "../shared/conventions.js";
import { getDb, loadConfig } from "./db.js";
import { Forgejo, ForgejoError } from "./forgejo.js";
import { ROLES, type Role } from "../shared/roles.js";
import {
  getWorkspaceMarkdownDrift,
  readWorkspaceFormatFromTopics,
  reindexWorkspaceFromForgejo,
} from "./workspace-provisioning.js";
import { deleteSidecarForWorkspace } from "./workspace-cleanup.js";
import {
  COFLAT_FORMAT_ID,
  DEFAULT_DOCUMENT_FORMAT_ID,
  documentFormatFromTopics,
  isDocumentFormatId,
  isFormatTopic,
  type DocumentFormatId,
} from "../shared/document-format.js";
import {
  SEED_PROFILES,
  isSeedProfile,
  seedWorkspace,
  type SeedOptions,
} from "./seed.js";

async function readPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }
  stdout.write(prompt);
  return new Promise<string>((resolve) => {
    let buf = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "") {
          stdout.write("\n");
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          resolve(buf);
          return;
        }
        if (ch === "") {
          stdin.setRawMode?.(false);
          stdin.pause();
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function ctx() {
  const config = loadConfig();
  const db = getDb(config);
  // CLI runs out-of-band of any HTTP request; use the admin token. This is
  // the one entry-point that's allowed to (the runtime request path never
  // touches the admin token — it uses per-user PATs).
  const forgejo = new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoAdminToken });
  return { config, db, forgejo };
}

interface CliWorkspaceRow {
  slug: string;
  defaultMdFormat: DocumentFormatId;
}

// Resolve a workspace by slug and hand the caller everything it needs.
// Exits 1 with a uniform "workspace 'x' not found" message on miss so callers
// don't repeat the same five lines.
async function withWorkspace<T>(
  slug: string,
  fn: (args: {
    config: ReturnType<typeof loadConfig>;
    db: ReturnType<typeof getDb>;
    forgejo: Forgejo;
    workspace: CliWorkspaceRow;
  }) => Promise<T> | T,
): Promise<T> {
  const { config, db, forgejo } = ctx();
  // Workspaces are identified solely by their Forgejo repo. The CLI
  // verifies existence against Forgejo and reads the markdown format from
  // the repo's topics.
  const repo = await forgejo.getRepo(config.forgejoOwner, slug);
  if (!repo) {
    console.error(`workspace '${slug}' not found`);
    process.exit(1);
  }
  const ws: CliWorkspaceRow = {
    slug,
    defaultMdFormat: await readWorkspaceFormatFromTopics(forgejo, config.forgejoOwner, slug),
  };
  return fn({ config, db, forgejo, workspace: ws });
}

function addSeedOptions(command: Command): Command {
  return command
    .requiredOption("--user <user>", "Forgejo username to create or seed as")
    .requiredOption("--password <password>", "Forgejo password for --user")
    .requiredOption("--workspace <slug>", "workspace repo slug")
    .option("--workspace-name <name>", "workspace display name; defaults to --workspace")
    .option("--default-md-format <id>", "workspace markdown format", DEFAULT_DOCUMENT_FORMAT_ID)
    .option("--profile <profile>", `seed profile (${SEED_PROFILES.join("|")})`, "all");
}

export function normalizeSeedOptions(opts: {
  user?: string;
  password?: string;
  workspace?: string;
  workspaceName?: string;
  defaultMdFormat?: string;
  profile?: string;
}): SeedOptions {
  const { user, password, workspace } = opts;
  if (!user) throw new InvalidArgumentError("seed requires --user");
  if (!password) throw new InvalidArgumentError("seed requires --password");
  if (!workspace) throw new InvalidArgumentError("seed requires --workspace");
  if (!WORKSPACE_SLUG_RE.test(workspace)) {
    throw new InvalidArgumentError(`workspace must match ${WORKSPACE_SLUG_RE}`);
  }
  const defaultMdFormat = opts.defaultMdFormat ?? DEFAULT_DOCUMENT_FORMAT_ID;
  if (!isDocumentFormatId(defaultMdFormat)) {
    throw new InvalidArgumentError(`--default-md-format must be a known DocumentFormatId, got: ${defaultMdFormat}`);
  }
  const profile = opts.profile ?? "all";
  if (!isSeedProfile(profile)) {
    throw new InvalidArgumentError(`--profile must be one of ${SEED_PROFILES.join("|")}, got: ${profile}`);
  }
  return {
    user,
    password,
    workspace,
    workspaceName: opts.workspaceName ?? workspace,
    defaultMdFormat,
    profile,
  };
}

export function parseSeedOptions(args: string[]): SeedOptions {
  const command = addSeedOptions(new Command("seed").exitOverride());
  command.parse(args, { from: "user" });
  return normalizeSeedOptions(command.opts());
}

// Create the Forgejo account if absent. Users live entirely on Forgejo;
// the password set here is the only password the user has — they type it
// at cosheaf's login form, cosheaf exchanges it for a PAT, and the SPA
// stores the PAT.
async function ensureForgejoUser(
  username: string,
  password: string,
): Promise<void> {
  const { forgejo } = ctx();
  const fjExisting = await forgejo.getUserByName(username);
  if (!fjExisting) {
    await forgejo.createUser({
      username,
      email: `${username}@cosheaf.local`,
      password,
      must_change_password: false,
    });
    console.log(`created forgejo user ${username}`);
  } else {
    console.log(`forgejo user ${username} already exists (password unchanged)`);
  }
}

async function userAdd(username: string): Promise<void> {
  const password = await readPassword(`forgejo password for ${username}: `);
  if (!password) {
    console.error("password required");
    process.exit(1);
  }
  await ensureForgejoUser(username, password);
}

async function seed(options: SeedOptions): Promise<void> {
  await ensureForgejoUser(options.user, options.password);

  const { config, db, forgejo } = ctx();
  await seedWorkspace({ options, db, forgejo, config });
}

async function workspaceRm(slug: string): Promise<void> {
  await withWorkspace(slug, async ({ db, forgejo, config, workspace: ws }) => {
    try {
      await forgejo.deleteRepo(config.forgejoOwner, ws.slug);
    } catch (err) {
      if (!(err instanceof ForgejoError && err.status === 404)) {
        console.error(`forgejo deleteRepo failed: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    deleteSidecarForWorkspace(db, ws.slug);
    console.log(`deleted workspace ${slug} (forgejo repo + sidecar)`);
  });
}

async function workspaceReindex(slug: string): Promise<void> {
  await withWorkspace(slug, async ({ db, forgejo, config, workspace: ws }) => {
    const count = await reindexWorkspaceFromForgejo(db, forgejo, config, ws);
    console.log(`reindexed ${count} markdown file${count === 1 ? "" : "s"} in workspace ${slug}`);
  });
}

async function workspaceMember(slug: string, username: string, role: Role): Promise<void> {
  await withWorkspace(slug, async ({ forgejo, config, workspace: ws }) => {
    // Forgejo's addCollaborator API returns 404 if the user doesn't exist
    // on Forgejo, which is the only "user" notion cosheaf has.
    await forgejo.addCollaborator(config.forgejoOwner, ws.slug, username, role);
    // Keep the branch-protection push whitelist in sync. Admin can direct-push;
    // write/read users can't. Adjust on every change so demotion takes effect.
    const bp = await forgejo.getBranchProtection(config.forgejoOwner, ws.slug, "main");
    const current = (bp as unknown as { push_whitelist_usernames?: string[] } | null)?.push_whitelist_usernames ?? [];
    const onList = current.includes(username);
    if (role === "admin" && !onList) {
      await forgejo.patchBranchProtectionPushWhitelist(config.forgejoOwner, ws.slug, "main", [...current, username]);
    } else if (role !== "admin" && onList) {
      await forgejo.patchBranchProtectionPushWhitelist(
        config.forgejoOwner,
        ws.slug,
        "main",
        current.filter((u) => u !== username),
      );
    }
    console.log(`set ${username} as ${role} in workspace ${slug}`);
  });
}

// --------------------------------- doctor ---------------------------------

type CheckStatus = "ok" | "fail" | "warn";
interface CheckResult { name: string; status: CheckStatus; detail: string }

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, status: "ok", detail };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

async function checkWarn(name: string, fn: () => Promise<{ status: "ok" | "warn"; detail: string }>): Promise<CheckResult> {
  try {
    const r = await fn();
    return { name, status: r.status, detail: r.detail };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

async function doctor(): Promise<void> {
  const { config, db, forgejo } = ctx();
  const results: CheckResult[] = [];

  results.push(
    await check("forgejo reachable", async () => {
      // Some Forgejo deployments require auth even on /version, so send the
      // runtime token. We'll check admin-scope separately below.
      const r = await fetch(`${config.forgejoUrl}/api/v1/version`, {
        headers: { authorization: `token ${config.forgejoToken}` },
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${config.forgejoUrl}`);
      const v = (await r.json()) as { version?: string };
      return `${config.forgejoUrl} → ${v.version ?? "unknown version"}`;
    }),
  );

  results.push(
    await check("runtime token is non-admin", async () => {
      const u = await new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoToken }).getCurrentUser();
      if (u.is_admin === true) {
        throw new Error("COSHEAF_FORGEJO_TOKEN is site-admin; use COSHEAF_FORGEJO_ADMIN_TOKEN for admin scope");
      }
      return u.login;
    }),
  );

  results.push(
    await check("admin token has admin scope", async () => {
      // /admin/users requires admin permission; a 200 means the token works
      // for provisioning. 401/403 → wrong token. 404 → ancient Forgejo.
      const r = await fetch(`${config.forgejoUrl}/api/v1/admin/users?limit=1`, {
        headers: { authorization: `token ${config.forgejoAdminToken}` },
      });
      if (r.status === 401 || r.status === 403) throw new Error("token rejected (not admin?)");
      if (!r.ok) throw new Error(`unexpected ${r.status}`);
      return "ok";
    }),
  );

  results.push(
    await check("admin user exists in forgejo", async () => {
      const u = await forgejo.getUserByName(config.forgejoOwner);
      if (!u) throw new Error(`COSHEAF_FORGEJO_OWNER=${config.forgejoOwner} not found`);
      return u.login;
    }),
  );

  results.push(
    await check("data dir writable", async () => {
      const probe = path.join(config.dataDir, ".doctor-probe");
      const fs = await import("node:fs/promises");
      await fs.writeFile(probe, "x");
      await fs.unlink(probe);
      return config.dataDir;
    }),
  );

  results.push(
    await check("schema applied (doc_map table exists)", async () => {
      db.prepare("SELECT 1 FROM doc_map LIMIT 1").get();
      return "ok";
    }),
  );

  results.push(
    await checkWarn("webhook_log dedupe table healthy", async () => {
      const total = (db.prepare("SELECT COUNT(*) AS n FROM webhook_log").get() as { n: number }).n;
      if (total === 0) return { status: "ok", detail: "empty (no deliveries yet)" };
      const bad = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM webhook_log WHERE delivery_id IS NULL OR delivery_id = '' OR delivered_at IS NULL OR delivered_at <= 0",
          )
          .get() as { n: number }
      ).n;
      if (bad > 0) throw new Error(`${bad}/${total} rows malformed`);
      return { status: "ok", detail: `${total} rows, all well-formed` };
    }),
  );

  // Per-workspace checks. Workspaces are enumerated from Forgejo (repos
  // under config.forgejoOwner with a `cosheaf-format-*` topic), not from
  // SQLite — there's no workspaces table anymore.
  const repos = await forgejo.listUserRepos(config.forgejoOwner, { limit: 50 });
  const workspaceRepos = repos.filter((r) => (r.topics ?? []).some(isFormatTopic));
  const workspaces = workspaceRepos.map((r) => ({
    slug: r.name,
    topics: r.topics ?? [],
    defaultMdFormat: documentFormatFromTopics(r.topics ?? []),
  }));
  const knownSlugs = new Set(workspaces.map((w) => w.slug));

  for (const ws of workspaces) {
    results.push(
      await check(`workspace ${ws.slug}: forgejo repo exists`, async () => {
        const r = await forgejo.getRepo(config.forgejoOwner, ws.slug);
        if (!r) throw new Error(`repo ${config.forgejoOwner}/${ws.slug} missing`);
        return r.full_name;
      }),
    );

    results.push(
      await check(`workspace ${ws.slug}: format topic well-formed`, async () => {
        const formatTopics = ws.topics.filter(isFormatTopic);
        if (formatTopics.length === 0) throw new Error("no cosheaf-format-* topic");
        if (formatTopics.length > 1) {
          throw new Error(`multiple format topics: ${formatTopics.join(", ")}`);
        }
        const suffix = formatTopics[0].slice("cosheaf-format-".length);
        if (!isDocumentFormatId(suffix)) {
          throw new Error(`unknown format suffix in topic ${formatTopics[0]}`);
        }
        if (suffix !== ws.defaultMdFormat) {
          throw new Error(`topic ${formatTopics[0]} does not match resolved format ${ws.defaultMdFormat}`);
        }
        return `${formatTopics[0]} → ${ws.defaultMdFormat}`;
      }),
    );

    if (ws.defaultMdFormat === COFLAT_FORMAT_ID) {
      results.push(
        await check(`workspace ${ws.slug}: webhook installed`, async () => {
          const hooks = await forgejo.listRepoHooks(config.forgejoOwner, ws.slug);
          const ours = hooks.find((h) => Array.isArray(h.events) && h.events.includes("push"));
          if (!ours) throw new Error("no push webhook on repo");
          return `hook id=${ours.id}`;
        }),
      );
      const lastDelivery = db
        .prepare(
          "SELECT delivered_at, event_type FROM webhook_log ORDER BY delivered_at DESC LIMIT 1",
        )
        .get() as { delivered_at: number; event_type: string } | undefined;
      results.push({
        name: `workspace ${ws.slug}: recent webhook activity`,
        status: lastDelivery !== undefined ? "ok" : "fail",
        detail: lastDelivery
          ? `last ${lastDelivery.event_type} at ${new Date(lastDelivery.delivered_at).toISOString()}`
          : "no webhook deliveries logged yet",
      });

      results.push(
        await checkWarn(`workspace ${ws.slug}: sidecar in sync with Forgejo tree`, async () => {
          const drift = await getWorkspaceMarkdownDrift(db, forgejo, config, ws);
          if (drift.onlySidecar.length === 0 && drift.onlyForgejo.length === 0) {
            return { status: "ok", detail: `${drift.inSync} pages` };
          }
          return {
            status: "warn",
            detail: `${drift.inSync} in sync, ${drift.onlySidecar.length} sidecar-only, ${drift.onlyForgejo.length} forgejo-only; run \`pnpm cli workspace reindex ${ws.slug}\``,
          };
        }),
      );
    } else {
      results.push({
        name: `workspace ${ws.slug}: no webhook expected (passthrough)`,
        status: "ok",
        detail: `format=${ws.defaultMdFormat}`,
      });
    }
  }

  // Sidecar-orphan check: any workspace_slug in doc_map that no longer
  // corresponds to a Forgejo repo carrying a cosheaf-format-* topic.
  const sidecarSlugs = (
    db.prepare("SELECT DISTINCT workspace_slug FROM doc_map").all() as Array<{ workspace_slug: string }>
  ).map((r) => r.workspace_slug);
  for (const slug of sidecarSlugs) {
    if (knownSlugs.has(slug)) continue;
    results.push(
      await check(`sidecar orphan: workspace ${slug}`, async () => {
        const repo = await forgejo.getRepo(config.forgejoOwner, slug);
        if (!repo) {
          throw new Error(`doc_map references ${slug} but Forgejo repo is gone; run \`pnpm cli workspace rm ${slug}\``);
        }
        const hasFormat = (repo.topics ?? []).some(isFormatTopic);
        if (!hasFormat) {
          throw new Error(`repo ${config.forgejoOwner}/${slug} exists but has no cosheaf-format-* topic; add a topic or run \`pnpm cli workspace rm ${slug}\``);
        }
        // Defensive: should be unreachable because knownSlugs is built from the same predicate.
        return "ok";
      }),
    );
  }

  let failed = 0;
  let warned = 0;
  for (const r of results) {
    const mark = r.status === "ok" ? "OK" : r.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${mark}] ${r.name} — ${r.detail}`);
    if (r.status === "fail") failed++;
    else if (r.status === "warn") warned++;
  }
  if (failed > 0) {
    console.error(`\n${failed} check${failed === 1 ? "" : "s"} failed${warned > 0 ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}`);
    process.exit(1);
  }
  const tail = warned > 0 ? ` (${warned} warning${warned === 1 ? "" : "s"})` : "";
  console.log(`\nall ${results.length} checks passed${tail}`);
}

// ---------------------------- inspect workspace ----------------------------

async function inspectWorkspace(slug: string): Promise<void> {
  await withWorkspace(slug, async ({ config, db, forgejo, workspace: ws }) => {
  const repo = await forgejo.getRepo(config.forgejoOwner, ws.slug).catch(() => null);
  const display = repo?.description?.trim() || ws.slug;
  console.log(
    `workspace ${ws.slug} (${display}) — forgejo repo ${config.forgejoOwner}/${ws.slug}, format ${ws.defaultMdFormat}\n`,
  );

  let drift;
  try {
    drift = await getWorkspaceMarkdownDrift(db, forgejo, config, ws);
  } catch (err) {
    console.error(`getTree failed: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`pages: ${drift.inSync} in sync, ${drift.onlySidecar.length} sidecar-only, ${drift.onlyForgejo.length} forgejo-only`);
  for (const p of drift.onlySidecar) console.log(`  - sidecar-only: ${p}   (run \`workspace reindex\`)`);
  for (const p of drift.onlyForgejo) console.log(`  - forgejo-only: ${p}   (webhook missed it; reindex)`);

  console.log();
  const recentHooks = db
    .prepare(
      "SELECT delivered_at, event_type, delivery_id FROM webhook_log ORDER BY delivered_at DESC LIMIT 10",
    )
    .all() as Array<{ delivered_at: number; event_type: string; delivery_id: string }>;
  if (recentHooks.length === 0) {
    console.log("webhook_log: empty (no deliveries yet)");
  } else {
    console.log(`webhook_log (last ${recentHooks.length}):`);
    for (const h of recentHooks) {
      console.log(`  ${new Date(h.delivered_at).toISOString()}  ${h.event_type.padEnd(20)} ${h.delivery_id}`);
    }
  }

  console.log();
  const pulls = await forgejo.listPulls(config.forgejoOwner, ws.slug, "open");
  console.log(`open PRs (${pulls.length}):`);
  for (const p of pulls) {
    console.log(`  #${p.number} ${p.title.slice(0, 60)}  by ${p.user?.login ?? "(deleted)"}  head=${p.head.ref}`);
  }

  console.log();
  const branches = await forgejo.listBranches(config.forgejoOwner, ws.slug);
  const userBranches = branches.filter((b) => b.name.startsWith("user/"));
  console.log(`user/* branches (${userBranches.length}):`);
  for (const b of userBranches.slice(0, 20)) {
    console.log(`  ${b.name}  @${b.commit?.id?.slice(0, 8) ?? "?"}`);
  }
  if (userBranches.length > 20) console.log(`  … ${userBranches.length - 20} more`);
  });
}

// ------------------------------- drift-check -------------------------------

// Diagnostic-only: compares `doc_map` against Forgejo's `main` tree for the
// given workspace. No auto-repair. Exit 1 if drift detected so the command
// is scriptable (e.g. periodic check, CI sanity).
async function workspaceDriftCheck(slug: string): Promise<void> {
  await withWorkspace(slug, async ({ config, db, forgejo, workspace: ws }) => {
  let drift;
  try {
    drift = await getWorkspaceMarkdownDrift(db, forgejo, config, ws);
  } catch (err) {
    console.error(`drift-check: getTree failed: ${(err as Error).message}`);
    process.exit(2);
  }

  if (drift.onlySidecar.length === 0 && drift.onlyForgejo.length === 0) {
    console.log(`drift-check ${slug}: clean (${drift.inSync} pages in sync)`);
    return;
  }

  console.log(`drift-check ${slug}: DRIFT (${drift.inSync} in sync, ${drift.onlySidecar.length} sidecar-only, ${drift.onlyForgejo.length} forgejo-only)`);
  for (const p of drift.onlySidecar) console.log(`  sidecar-only: ${p}`);
  for (const p of drift.onlyForgejo) console.log(`  forgejo-only: ${p}`);
  console.log(`\nrun \`pnpm cli workspace reindex ${slug}\` to rebuild from Forgejo`);
  process.exit(1);
  });
}

// ---------------------------------- repl ----------------------------------

function startRepl(): void {
  const { config, db, forgejo } = ctx();
  console.log(
    "cosheaf repl — bindings: db (better-sqlite3), forgejo (admin Forgejo client), config\n" +
      "  e.g.  db.prepare('SELECT * FROM doc_map').all()\n" +
      "        await forgejo.getRepo(config.forgejoOwner, 'notes')\n",
  );
  const r = repl.start({ prompt: "cosheaf> ", useGlobal: true, breakEvalOnSigint: true });
  r.context.db = db;
  r.context.forgejo = forgejo;
  r.context.config = config;
}

// ------------------------------- reset-dev -------------------------------

async function resetDev(opts: { keepForgejo: boolean; yes: boolean }): Promise<void> {
  const { config, db, forgejo } = ctx();
  // Workspaces are enumerated from Forgejo, not SQLite.
  const allRepos = await forgejo.listUserRepos(config.forgejoOwner, { limit: 50 });
  const repos = allRepos
    .filter((r) => (r.topics ?? []).some(isFormatTopic))
    .map((r) => `${config.forgejoOwner}/${r.name}`);

  console.error("This will:");
  console.error(`  - delete ${path.join(config.dataDir, "db.sqlite")} (+ -shm/-wal)`);
  if (!opts.keepForgejo) {
    for (const r of repos) console.error(`  - delete forgejo repo ${r}`);
  } else {
    console.error("  - keep all forgejo repos (--keep-forgejo)");
  }
  console.error(`  - re-seed via pnpm setup:dev defaults`);
  if (!opts.yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = (await rl.question("continue? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") {
      console.error("aborted");
      process.exit(1);
    }
  }

  if (!opts.keepForgejo) {
    for (const r of allRepos.filter((rr) => (rr.topics ?? []).some(isFormatTopic))) {
      try {
        await forgejo.deleteRepo(config.forgejoOwner, r.name);
        console.error(`deleted forgejo repo ${r.name}`);
      } catch (err) {
        if (!(err instanceof ForgejoError && err.status === 404)) {
          console.error(`warning: deleteRepo ${r.name} failed: ${(err as Error).message}`);
        }
      }
    }
  }

  // Close DB before unlinking — better-sqlite3 holds the handle.
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = path.join(config.dataDir, `db.sqlite${suffix}`);
    if (existsSync(file)) unlinkSync(file);
  }
  console.error("wiped local DB; run `pnpm setup:dev` to reseed.");
}

function parseRole(value: string): Role {
  if (!(ROLES as readonly string[]).includes(value))
    throw new InvalidArgumentError(`role must be ${ROLES.join("|")}`);
  return value as Role;
}

function buildProgram(): Command {
  const program = new Command("cosheaf").description("cosheaf admin CLI").exitOverride();

  addSeedOptions(
    program
      .command("seed")
      .description("create-or-update a forgejo user and workspace for local development"),
  ).action((opts) => seed(normalizeSeedOptions(opts)));

  const user = program.command("user").description("user management");
  user.command("add <username>").description("create a forgejo user; prompts for password").action(userAdd);
  user
    .command("create <username> <password>")
    .description("non-interactive create (dev/CI use)")
    .action(ensureForgejoUser);

  const workspace = program.command("workspace").description("workspace management");
  workspace
    .command("member <slug> <username> <role>")
    .description("set a collaborator's Forgejo role (admin|write|read)")
    .action((slug, username, roleArg) => workspaceMember(slug, username, parseRole(roleArg)));
  workspace
    .command("reindex <slug>")
    .description("rebuild the SQLite sidecar from Forgejo main")
    .action(workspaceReindex);
  workspace
    .command("rm <slug>")
    .description("delete the Forgejo repo and the SQLite sidecar")
    .action(workspaceRm);
  workspace
    .command("inspect <slug>")
    .description("show sidecar vs forgejo drift, recent webhook deliveries, open PRs, user branches")
    .action(inspectWorkspace);
  workspace
    .command("drift-check <slug>")
    .description("diagnostic: report differences between doc_map and Forgejo's main tree (exit 1 on drift)")
    .action(workspaceDriftCheck);

  program
    .command("doctor")
    .description("check that forgejo, admin token, schema, and per-workspace state are sane")
    .action(doctor);

  program
    .command("repl")
    .description("Node REPL with db, forgejo (admin), and config preloaded")
    .action(startRepl);

  program
    .command("reset-dev")
    .description("wipe the local DB and (optionally) the workspace forgejo repos, then reseed")
    .option("--keep-forgejo", "do not delete forgejo repos", false)
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action(resetDev);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof Error && "code" in err) {
      const code = (err as { code?: string }).code;
      if (code === "commander.help" || code === "commander.helpDisplayed") return;
      if (code === "commander.version") return;
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  void main();
}
