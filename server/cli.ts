import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getDb, loadConfig } from "./db.js";
import {
  createUser,
  ensureForgejoProxy,
  findUserByUsername,
  hashPassword,
  setUserPassword,
} from "./users.js";
import { Forgejo } from "./forgejo.js";
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
  // Cascade deletes memberships, doc_map, etc.
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

async function workspaceMember(slug: string, username: string, role: "owner" | "verifier" | "member"): Promise<void> {
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
  db.prepare(
    "INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role",
  ).run(ws.id, user.id, role);
  // Grant write so the user's proxy can push branches; main is still gated by branch protection.
  await forgejo.addCollaborator(config.forgejoOwner, ws.forgejo_repo, fj, "write");
  if (role === "owner") {
    const bp = await forgejo.getBranchProtection(config.forgejoOwner, ws.forgejo_repo, "main");
    const current = (bp as unknown as { push_whitelist_usernames?: string[] } | null)?.push_whitelist_usernames ?? [];
    if (!current.includes(fj)) {
      await forgejo.patchBranchProtectionPushWhitelist(config.forgejoOwner, ws.forgejo_repo, "main", [...current, fj]);
    }
  }
  console.log(`set ${username} as ${role} in workspace ${slug}`);
}

function help(): void {
  console.log(`Usage:
  cosheaf seed --user <username> --password <password> --workspace <slug> --workspace-name <name>
  cosheaf user add <username>
  cosheaf user create <username> <password>   # non-interactive (dev/CI use)
  cosheaf user passwd <username>
  cosheaf user list
  cosheaf user rm <username>
  cosheaf workspace member <slug> <username> <role>   # role = owner|verifier|member
  cosheaf workspace reindex <slug>                     # rebuild sidecar index from Forgejo main
  cosheaf workspace rm <slug>                          # delete forgejo repo + sidecar
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, sub, ...rest] = argv;

  if (cmd === "seed") return seed(argv.slice(1));
  if (cmd === "user" && sub === "add" && rest[0]) return userAdd(rest[0]);
  if (cmd === "user" && sub === "create" && rest[0] && rest[1]) return userCreate(rest[0], rest[1]);
  if (cmd === "user" && sub === "passwd" && rest[0]) return userPasswd(rest[0]);
  if (cmd === "user" && sub === "list") return userList();
  if (cmd === "user" && sub === "rm" && rest[0]) return userRm(rest[0]);
  if (cmd === "workspace" && sub === "reindex" && rest[0]) return workspaceReindex(rest[0]);
  if (cmd === "workspace" && sub === "rm" && rest[0]) return workspaceRm(rest[0]);
  if (cmd === "workspace" && sub === "member" && rest[0] && rest[1] && rest[2]) {
    const role = rest[2];
    if (role !== "owner" && role !== "verifier" && role !== "member") {
      console.error("role must be owner|verifier|member");
      process.exit(1);
    }
    return workspaceMember(rest[0], rest[1], role);
  }

  help();
  process.exit(cmd ? 1 : 0);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
