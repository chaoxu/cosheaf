import { createInterface } from "node:readline/promises";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import repl from "node:repl";
import { stdin, stdout } from "node:process";
import { Command, InvalidArgumentError } from "commander";
import { WORKSPACE_SLUG_RE } from "../shared/conventions.js";
import { getDb, loadConfig } from "./db.js";
import { findUserByUsername, upsertUserFromForgejo } from "./users.js";
import { Forgejo, ForgejoError } from "./forgejo.js";
import { ROLES, type Role } from "../shared/roles.js";
import {
  ensureWorkspaceFile,
  provisionWorkspace,
  reindexWorkspaceFromForgejo,
} from "./workspace-provisioning.js";
import { COFLAT_FORMAT_ID } from "../shared/document-format.js";

interface SeedOptions {
  user: string;
  password: string;
  workspace: string;
  workspaceName: string;
}

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
  const forgejo = new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoToken });
  return { config, db, forgejo };
}

function valueFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      const value = args[i + 1];
      return value && !value.startsWith("-") ? value : undefined;
    }
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export function parseSeedOptions(args: string[]): SeedOptions {
  const user = valueFlag(args, "--user");
  const password = valueFlag(args, "--password");
  const workspace = valueFlag(args, "--workspace");
  const workspaceName = valueFlag(args, "--workspace-name") ?? workspace;
  const missing = [
    ["--user", user],
    ["--password", password],
    ["--workspace", workspace],
    ["--workspace-name", workspaceName],
  ]
    .filter(([, value]) => !value)
    .map(([flag]) => flag);
  if (missing.length > 0) {
    throw new Error(`seed requires ${missing.join(", ")}`);
  }
  if (!WORKSPACE_SLUG_RE.test(workspace ?? "")) {
    throw new Error(`workspace must match ${WORKSPACE_SLUG_RE}`);
  }
  return {
    user: user as string,
    password: password as string,
    workspace: workspace as string,
    workspaceName: workspaceName as string,
  };
}

// Create the Forgejo account if absent, then mirror as a cosheaf user row.
// The password is set on the Forgejo side — that's the only password the
// user has, and they use it to log into cosheaf, which validates against
// Forgejo and stores a per-user PAT.
async function ensureForgejoUser(
  username: string,
  password: string,
): Promise<void> {
  const { db, forgejo } = ctx();
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
  if (!findUserByUsername(db, username)) {
    upsertUserFromForgejo(db, username);
    console.log(`mirrored cosheaf user ${username}`);
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

async function seed(args: string[]): Promise<void> {
  const options = parseSeedOptions(args);
  await ensureForgejoUser(options.user, options.password);

  const { config, db, forgejo } = ctx();
  const user = findUserByUsername(db, options.user);
  if (!user) {
    console.error(`user ${options.user} not in cosheaf DB after creation`);
    process.exit(1);
  }
  const { workspace, createdRepo } = await provisionWorkspace(db, forgejo, config, {
    slug: options.workspace,
    name: options.workspaceName,
    user,
    forgejoUsername: options.user,
    allowExistingLocal: true,
    defaultMdFormat: COFLAT_FORMAT_ID,
  });
  console.log(`${createdRepo ? "created" : "ensured"} workspace ${options.workspace}`);

  const files = [
    {
      path: ".gitattributes",
      content: "*.md text eol=lf -text\n",
      message: "chore: lock byte-exactness for .md",
    },
    {
      path: "hello.md",
      content: [
        "---",
        "id: hello",
        "title: Hello",
        "---",
        "# Hello",
        "",
        `This is the default development page for ${options.workspaceName}.`,
        "",
      ].join("\n"),
      message: "docs: add development hello page",
    },
  ];

  for (const file of files) {
    const created = await ensureWorkspaceFile(forgejo, config, workspace.forgejo_repo, file);
    if (created) console.log(`created ${file.path}`);
  }
  await reindexWorkspaceFromForgejo(db, forgejo, config, workspace);

  console.log(`seeded dev workspace: user=${options.user} workspace=${options.workspace}`);
}

function userList(): void {
  const { db } = ctx();
  const rows = db
    .prepare("SELECT id, username, created_at FROM users ORDER BY username")
    .all() as Array<{ id: number; username: string; created_at: number }>;
  for (const row of rows) {
    console.log(`${row.id}\t${row.username}\t${new Date(row.created_at).toISOString()}`);
  }
}

function userRm(username: string): void {
  const { db } = ctx();
  const r = db.prepare("DELETE FROM users WHERE username = ?").run(username);
  if (r.changes === 0) {
    console.error(`user '${username}' not found`);
    process.exit(1);
  }
  console.log(`deleted cosheaf user ${username} (forgejo account left intact)`);
}

async function workspaceRm(slug: string): Promise<void> {
  const { db, forgejo, config } = ctx();
  const ws = db.prepare("SELECT id, forgejo_repo FROM workspaces WHERE slug = ?").get(slug) as { id: number; forgejo_repo: string } | undefined;
  if (!ws) {
    console.error(`workspace '${slug}' not found`);
    process.exit(1);
  }
  try {
    await forgejo.deleteRepo(config.forgejoOwner, ws.forgejo_repo);
  } catch (err) {
    if (!(err instanceof ForgejoError && err.status === 404)) {
      console.error(`forgejo deleteRepo failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);
  db.prepare("DELETE FROM notes_fts WHERE workspace_id = ?").run(ws.id);
  db.prepare("DELETE FROM backlinks WHERE workspace_id = ?").run(ws.id);
  db.prepare("DELETE FROM page_tags WHERE workspace_id = ?").run(ws.id);
  console.log(`deleted workspace ${slug} (forgejo repo + sidecar)`);
}

async function workspaceReindex(slug: string): Promise<void> {
  const { db, forgejo, config } = ctx();
  const ws = db
    .prepare("SELECT id, slug, name, forgejo_repo, default_md_format FROM workspaces WHERE slug = ?")
    .get(slug) as
      | { id: number; slug: string; name: string; forgejo_repo: string; default_md_format: string }
      | undefined;
  if (!ws) {
    console.error(`workspace '${slug}' not found`);
    process.exit(1);
  }
  const count = await reindexWorkspaceFromForgejo(db, forgejo, config, ws);
  console.log(`reindexed ${count} markdown file${count === 1 ? "" : "s"} in workspace ${slug}`);
}

async function workspaceMember(slug: string, username: string, role: Role): Promise<void> {
  const { db, forgejo, config } = ctx();
  const ws = db.prepare("SELECT id, forgejo_repo FROM workspaces WHERE slug = ?").get(slug) as { id: number; forgejo_repo: string } | undefined;
  if (!ws) {
    console.error(`workspace '${slug}' not found`);
    process.exit(1);
  }
  const user = findUserByUsername(db, username);
  if (!user) {
    console.error(`user '${username}' not found in cosheaf; run \`cli user add\` first`);
    process.exit(1);
  }
  await forgejo.addCollaborator(config.forgejoOwner, ws.forgejo_repo, username, role);
  // Keep the branch-protection push whitelist in sync. Admin can direct-push;
  // write/read users can't. Adjust on every change so demotion takes effect.
  const bp = await forgejo.getBranchProtection(config.forgejoOwner, ws.forgejo_repo, "main");
  const current = (bp as unknown as { push_whitelist_usernames?: string[] } | null)?.push_whitelist_usernames ?? [];
  const onList = current.includes(username);
  if (role === "admin" && !onList) {
    await forgejo.patchBranchProtectionPushWhitelist(config.forgejoOwner, ws.forgejo_repo, "main", [...current, username]);
  } else if (role !== "admin" && onList) {
    await forgejo.patchBranchProtectionPushWhitelist(
      config.forgejoOwner,
      ws.forgejo_repo,
      "main",
      current.filter((u) => u !== username),
    );
  }
  console.log(`set ${username} as ${role} in workspace ${slug}`);
}

function passthroughLog(slug: string): void {
  const { db } = ctx();
  const ws = db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(slug) as
    | { id: number }
    | undefined;
  if (!ws) {
    console.error(`workspace '${slug}' not found`);
    process.exit(1);
  }
  const rows = db
    .prepare(
      "SELECT l.created_at, l.method, l.path, l.query, l.status, l.duration_ms, u.username " +
        "FROM forgejo_passthrough_log l JOIN users u ON u.id = l.user_id " +
        "WHERE l.workspace_id = ? ORDER BY l.created_at DESC LIMIT 50",
    )
    .all(ws.id) as Array<{
    created_at: number;
    method: string;
    path: string;
    query: string | null;
    status: number;
    duration_ms: number;
    username: string;
  }>;
  for (const row of rows) {
    const ts = new Date(row.created_at).toISOString();
    const qs = row.query ? `?${row.query}` : "";
    console.log(
      `${ts}\t${row.username}\t${row.method}\t${row.path}${qs}\t${row.status}\t${row.duration_ms}ms`,
    );
  }
}

// --------------------------------- doctor ---------------------------------

interface CheckResult { name: string; ok: boolean; detail: string }

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
}

async function doctor(): Promise<void> {
  const { config, db, forgejo } = ctx();
  const results: CheckResult[] = [];

  results.push(
    await check("forgejo reachable", async () => {
      // Some Forgejo deployments require auth even on /version, so send the
      // admin token. We'll check admin-scope separately below.
      const r = await fetch(`${config.forgejoUrl}/api/v1/version`, {
        headers: { authorization: `token ${config.forgejoToken}` },
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${config.forgejoUrl}`);
      const v = (await r.json()) as { version?: string };
      return `${config.forgejoUrl} → ${v.version ?? "unknown version"}`;
    }),
  );

  results.push(
    await check("admin token has admin scope", async () => {
      // /admin/users requires admin permission; a 200 means the token works
      // for provisioning. 401/403 → wrong token. 404 → ancient Forgejo.
      const r = await fetch(`${config.forgejoUrl}/api/v1/admin/users?limit=1`, {
        headers: { authorization: `token ${config.forgejoToken}` },
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
    await check("schema applied (users + workspaces tables exist)", async () => {
      db.prepare("SELECT 1 FROM users LIMIT 1").get();
      db.prepare("SELECT 1 FROM workspaces LIMIT 1").get();
      return "ok";
    }),
  );

  // Per-workspace checks
  const workspaces = db
    .prepare("SELECT id, slug, forgejo_repo, default_md_format FROM workspaces ORDER BY slug")
    .all() as Array<{ id: number; slug: string; forgejo_repo: string; default_md_format: string }>;
  for (const ws of workspaces) {
    results.push(
      await check(`workspace ${ws.slug}: forgejo repo exists`, async () => {
        const r = await forgejo.getRepo(config.forgejoOwner, ws.forgejo_repo);
        if (!r) throw new Error(`repo ${config.forgejoOwner}/${ws.forgejo_repo} missing`);
        return r.full_name;
      }),
    );
    results.push(
      await check(`workspace ${ws.slug}: webhook installed`, async () => {
        const hooks = await forgejo.listRepoHooks(config.forgejoOwner, ws.forgejo_repo);
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
      ok: lastDelivery !== undefined,
      detail: lastDelivery
        ? `last ${lastDelivery.event_type} at ${new Date(lastDelivery.delivered_at).toISOString()}`
        : "no webhook deliveries logged yet",
    });
  }

  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? "OK" : "FAIL";
    console.log(`[${mark}] ${r.name} — ${r.detail}`);
    if (!r.ok) failed++;
  }
  if (failed > 0) {
    console.error(`\n${failed} check${failed === 1 ? "" : "s"} failed`);
    process.exit(1);
  }
  console.log(`\nall ${results.length} checks passed`);
}

// ---------------------------- inspect workspace ----------------------------

async function inspectWorkspace(slug: string): Promise<void> {
  const { config, db, forgejo } = ctx();
  const ws = db
    .prepare("SELECT id, slug, name, forgejo_repo, default_md_format FROM workspaces WHERE slug = ?")
    .get(slug) as
      | { id: number; slug: string; name: string; forgejo_repo: string; default_md_format: string }
      | undefined;
  if (!ws) {
    console.error(`workspace '${slug}' not found`);
    process.exit(1);
  }

  console.log(
    `workspace ${ws.slug} (${ws.name}) — forgejo repo ${config.forgejoOwner}/${ws.forgejo_repo}, format ${ws.default_md_format}\n`,
  );

  const sidecarPaths = new Set(
    (
      db
        .prepare("SELECT forgejo_id AS path FROM doc_map WHERE workspace_id = ?")
        .all(ws.id) as Array<{ path: string }>
    ).map((r) => r.path),
  );
  let forgejoPaths: Set<string>;
  try {
    const tree = await forgejo.getTree(config.forgejoOwner, ws.forgejo_repo, "main", true);
    forgejoPaths = new Set(
      tree.filter((e) => e.type === "blob" && e.path.endsWith(".md")).map((e) => e.path),
    );
  } catch (err) {
    console.error(`getTree failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const onlySidecar = [...sidecarPaths].filter((p) => !forgejoPaths.has(p)).sort();
  const onlyForgejo = [...forgejoPaths].filter((p) => !sidecarPaths.has(p)).sort();
  const both = sidecarPaths.size + forgejoPaths.size - onlySidecar.length - onlyForgejo.length;

  console.log(`pages: ${both} in sync, ${onlySidecar.length} sidecar-only, ${onlyForgejo.length} forgejo-only`);
  for (const p of onlySidecar) console.log(`  - sidecar-only: ${p}   (run \`workspace reindex\`)`);
  for (const p of onlyForgejo) console.log(`  - forgejo-only: ${p}   (webhook missed it; reindex)`);

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
  const pulls = await forgejo.listPulls(config.forgejoOwner, ws.forgejo_repo, "open");
  console.log(`open PRs (${pulls.length}):`);
  for (const p of pulls) {
    console.log(`  #${p.number} ${p.title.slice(0, 60)}  by ${p.user?.login ?? "(deleted)"}  head=${p.head.ref}`);
  }

  console.log();
  const branches = await forgejo.listBranches(config.forgejoOwner, ws.forgejo_repo);
  const userBranches = branches.filter((b) => b.name.startsWith("user/"));
  console.log(`user/* branches (${userBranches.length}):`);
  for (const b of userBranches.slice(0, 20)) {
    console.log(`  ${b.name}  @${b.commit?.id?.slice(0, 8) ?? "?"}`);
  }
  if (userBranches.length > 20) console.log(`  … ${userBranches.length - 20} more`);
}

// ---------------------------------- repl ----------------------------------

function startRepl(): void {
  const { config, db, forgejo } = ctx();
  console.log(
    "cosheaf repl — bindings: db (better-sqlite3), forgejo (admin Forgejo client), config\n" +
      "  e.g.  db.prepare('SELECT * FROM workspaces').all()\n" +
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
  const workspaces = db
    .prepare("SELECT slug, forgejo_repo FROM workspaces")
    .all() as Array<{ slug: string; forgejo_repo: string }>;
  const repos = workspaces.map((w) => `${config.forgejoOwner}/${w.forgejo_repo}`);

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
    for (const w of workspaces) {
      try {
        await forgejo.deleteRepo(config.forgejoOwner, w.forgejo_repo);
        console.error(`deleted forgejo repo ${w.forgejo_repo}`);
      } catch (err) {
        if (!(err instanceof ForgejoError && err.status === 404)) {
          console.error(`warning: deleteRepo ${w.forgejo_repo} failed: ${(err as Error).message}`);
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

  program
    .command("seed")
    .description("create-or-update a forgejo user and workspace for local development")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action((_opts, cmd) => seed(cmd.args));

  const user = program.command("user").description("user management");
  user.command("add <username>").description("create a forgejo user; prompts for password").action(userAdd);
  user
    .command("create <username> <password>")
    .description("non-interactive create (dev/CI use)")
    .action(ensureForgejoUser);
  user.command("list").description("list cosheaf users").action(userList);
  user.command("rm <username>").description("remove from cosheaf (forgejo account preserved)").action(userRm);

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

  program
    .command("passthrough-log <slug>")
    .description("last 50 /forgejo/* passthrough calls")
    .action(passthroughLog);

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
