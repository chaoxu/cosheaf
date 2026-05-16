import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command, InvalidArgumentError } from "commander";
import { getDb, loadConfig } from "./db.js";
import {
  createUser,
  ensureForgejoProxy,
  findUserByUsername,
  hashPassword,
  setUserPassword,
} from "./users.js";
import { Forgejo } from "./forgejo.js";
import { ROLES, type Role } from "../shared/roles.js";
import {
  ensureWorkspaceFile,
  provisionWorkspace,
  reindexWorkspaceFromForgejo,
} from "./workspace-provisioning.js";

interface SeedOptions {
  user: string;
  password: string;
  workspace: string;
  workspaceName: string;
}

async function readPassword(prompt: string): Promise<string> {
  // For non-TTY stdin (piped input like `echo pw | cli`), readline echoes
  // are harmless and we want to keep that path working unchanged.
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }
  // TTY: muted input. Set raw mode and read char-by-char until newline.
  stdout.write(prompt);
  return new Promise<string>((resolve) => {
    let buf = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "") {
          stdout.write("\n");
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          resolve(buf);
          return;
        }
        if (ch === "") {
          // Ctrl-C
          stdin.setRawMode?.(false);
          stdin.pause();
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
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
  const forgejo = new Forgejo({ baseUrl: config.forgejoUrl, adminToken: config.forgejoToken });
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
  if (!/^[a-z0-9][a-z0-9-]*$/.test(workspace ?? "")) {
    throw new Error("workspace must match /^[a-z0-9][a-z0-9-]*$/");
  }
  return {
    user: user as string,
    password: password as string,
    workspace: workspace as string,
    workspaceName: workspaceName as string,
  };
}

async function userAdd(username: string): Promise<void> {
  const { db, forgejo } = ctx();
  if (findUserByUsername(db, username)) {
    console.error(`user '${username}' already exists`);
    process.exit(1);
  }
  const password = await readPassword(`password for ${username}: `);
  if (!password) {
    console.error("password required");
    process.exit(1);
  }
  const hash = await hashPassword(password);
  const user = createUser(db, username, hash);
  const fj = await ensureForgejoProxy(db, forgejo, user);
  console.log(`created user ${user.username} (id=${user.id}, forgejo=${fj})`);
}

async function userCreate(username: string, password: string): Promise<void> {
  await ensureSeedUser(username, password);
}

async function userPasswd(username: string): Promise<void> {
  const { db } = ctx();
  if (!findUserByUsername(db, username)) {
    console.error(`user '${username}' not found`);
    process.exit(1);
  }
  const password = await readPassword(`new password for ${username}: `);
  if (!password) {
    console.error("password required");
    process.exit(1);
  }
  const hash = await hashPassword(password);
  setUserPassword(db, username, hash);
  console.log(`updated password for ${username}`);
}

async function ensureSeedUser(username: string, password: string): Promise<{ id: number; username: string; forgejo_username: string | null }> {
  const { db, forgejo } = ctx();
  const passwordHash = await hashPassword(password);
  const existing = findUserByUsername(db, username);
  if (existing) {
    setUserPassword(db, username, passwordHash);
    const fj = await ensureForgejoProxy(db, forgejo, existing);
    console.log(`updated user ${username} (forgejo=${fj})`);
    return findUserByUsername(db, username) ?? existing;
  }
  const user = createUser(db, username, passwordHash);
  const fj = await ensureForgejoProxy(db, forgejo, user);
  console.log(`created user ${username} (id=${user.id}, forgejo=${fj})`);
  return findUserByUsername(db, username) ?? user;
}

async function seed(args: string[]): Promise<void> {
  const options = parseSeedOptions(args);
  const user = await ensureSeedUser(options.user, options.password);
  const { config, db, forgejo } = ctx();
  const fjUser = await ensureForgejoProxy(db, forgejo, user);
  const { workspace, createdRepo } = await provisionWorkspace(db, forgejo, config, {
    slug: options.workspace,
    name: options.workspaceName,
    user,
    forgejoUsername: fjUser,
    allowExistingLocal: true,
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
    const created = await ensureWorkspaceFile(forgejo, config, workspace.forgejo_repo, fjUser, file);
    if (created) {
      console.log(`created ${file.path}`);
    }
  }
  await reindexWorkspaceFromForgejo(db, forgejo, config, workspace);

  console.log(`seeded dev workspace: user=${options.user} workspace=${options.workspace}`);
}

function userList(): void {
  const { db } = ctx();
  const rows = db
    .prepare("SELECT id, username, forgejo_username, created_at FROM users ORDER BY username")
    .all() as Array<{ id: number; username: string; forgejo_username: string | null; created_at: number }>;
  for (const row of rows) {
    console.log(`${row.id}\t${row.username}\t${row.forgejo_username ?? "-"}\t${new Date(row.created_at).toISOString()}`);
  }
}

function userRm(username: string): void {
  const { db } = ctx();
  const r = db.prepare("DELETE FROM users WHERE username = ?").run(username);
  if (r.changes === 0) {
    console.error(`user '${username}' not found`);
    process.exit(1);
  }
  console.log(`deleted user ${username}`);
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
    // 404 is fine — repo already gone.
    const status = (err as { status?: number }).status;
    if (status !== 404) {
      console.error(`forgejo deleteRepo failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);
  // FTS / backlinks / page_tags reference workspace_id without FK cascade; clean explicitly.
  db.prepare("DELETE FROM notes_fts WHERE workspace_id = ?").run(ws.id);
  db.prepare("DELETE FROM backlinks WHERE workspace_id = ?").run(ws.id);
  db.prepare("DELETE FROM page_tags WHERE workspace_id = ?").run(ws.id);
  console.log(`deleted workspace ${slug} (forgejo repo + sidecar)`);
}

async function workspaceReindex(slug: string): Promise<void> {
  const { db, forgejo, config } = ctx();
  const ws = db
    .prepare("SELECT id, slug, name, forgejo_repo FROM workspaces WHERE slug = ?")
    .get(slug) as { id: number; slug: string; name: string; forgejo_repo: string } | undefined;
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
    console.error(`user '${username}' not found`);
    process.exit(1);
  }
  const fj = await ensureForgejoProxy(db, forgejo, user);
  await forgejo.addCollaborator(config.forgejoOwner, ws.forgejo_repo, fj, role);
  if (role === "admin") {
    // Admins can direct-push to main (branch protection has a push whitelist
    // for direct-merge operations from the cosheaf UI).
    const bp = await forgejo.getBranchProtection(config.forgejoOwner, ws.forgejo_repo, "main");
    const current = (bp as unknown as { push_whitelist_usernames?: string[] } | null)?.push_whitelist_usernames ?? [];
    if (!current.includes(fj)) {
      await forgejo.patchBranchProtectionPushWhitelist(config.forgejoOwner, ws.forgejo_repo, "main", [...current, fj]);
    }
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

function parseRole(value: string): Role {
  if (!(ROLES as readonly string[]).includes(value))
    throw new InvalidArgumentError(`role must be ${ROLES.join("|")}`);
  return value as Role;
}

function buildProgram(): Command {
  const program = new Command("cosheaf").description("cosheaf admin CLI").exitOverride();

  // `seed`: keep the raw-args pipeline through parseSeedOptions so its
  // behavior (and dedicated test) stays the single source of truth for
  // option parsing + validation. allowUnknownOption is on so commander
  // doesn't reject e.g. `--password=…`.
  program
    .command("seed")
    .description("create-or-update a user and workspace for local development")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action((_opts, cmd) => seed(cmd.args));

  const user = program.command("user").description("user management");
  user.command("add <username>").description("create a user; prompts for password").action(userAdd);
  user
    .command("create <username> <password>")
    .description("non-interactive create (dev/CI use)")
    .action(userCreate);
  user.command("passwd <username>").description("reset a user's password").action(userPasswd);
  user.command("list").description("list users").action(userList);
  user.command("rm <username>").description("delete a user").action(userRm);

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

  program
    .command("passthrough-log <slug>")
    .description("last 50 /forgejo/* passthrough calls")
    .action(passthroughLog);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof Error && "code" in err) {
      // Commander already printed the help/error; just exit non-zero unless
      // it was the user explicitly asking for help.
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
