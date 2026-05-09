import { mkdirSync, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { workspaceDir, getDb, loadConfig } from "./db.js";
import {
  createUser,
  findUserByUsername,
  hashPassword,
  setUserPassword,
} from "./auth.js";
import { indexDocument } from "./indexer.js";

async function readPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function userAdd(username: string): Promise<void> {
  const config = loadConfig();
  const db = getDb(config);
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
  console.log(`created user ${user.username} (id=${user.id})`);
}

async function userPasswd(username: string): Promise<void> {
  const config = loadConfig();
  const db = getDb(config);
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

function userList(): void {
  const config = loadConfig();
  const db = getDb(config);
  const rows = db.prepare("SELECT id, username, created_at FROM users ORDER BY username").all() as Array<{
    id: number;
    username: string;
    created_at: number;
  }>;
  for (const row of rows) {
    console.log(`${row.id}\t${row.username}\t${new Date(row.created_at).toISOString()}`);
  }
}

function userRm(username: string): void {
  const config = loadConfig();
  const db = getDb(config);
  const r = db.prepare("DELETE FROM users WHERE username = ?").run(username);
  if (r.changes === 0) {
    console.error(`user '${username}' not found`);
    process.exit(1);
  }
  console.log(`deleted user ${username}`);
}

function workspaceAdd(slug: string, name: string, ownerUsername: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error("invalid slug (lowercase letters, digits, dashes)");
    process.exit(1);
  }
  const config = loadConfig();
  const db = getDb(config);
  const owner = findUserByUsername(db, ownerUsername);
  if (!owner) {
    console.error(`owner '${ownerUsername}' not found`);
    process.exit(1);
  }
  const tx = db.transaction(() => {
    const ws = db
      .prepare("INSERT INTO workspaces (slug, name, created_at) VALUES (?, ?, ?) RETURNING id")
      .get(slug, name, Date.now()) as { id: number };
    db.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(
      ws.id,
      owner.id,
    );
    return ws.id;
  });
  let id: number;
  try {
    id = tx();
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE")) {
      console.error(`slug '${slug}' already taken`);
      process.exit(1);
    }
    throw err;
  }
  mkdirSync(workspaceDir(config, slug), { recursive: true });
  console.log(`created workspace ${slug} (id=${id}, owner=${ownerUsername})`);
}

function workspaceMember(slug: string, username: string, role: string): void {
  if (!["owner", "verifier", "member"].includes(role)) {
    console.error("role must be one of: owner, verifier, member");
    process.exit(1);
  }
  const config = loadConfig();
  const db = getDb(config);
  const ws = db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(slug) as
    | { id: number }
    | undefined;
  if (!ws) {
    console.error(`workspace '${slug}' not found`);
    process.exit(1);
  }
  const user = findUserByUsername(db, username);
  if (!user) {
    console.error(`user '${username}' not found`);
    process.exit(1);
  }
  db.prepare(
    "INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?) " +
      "ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role",
  ).run(ws.id, user.id, role);
  console.log(`added ${username} as ${role} of ${slug}`);
}

async function workspaceReindex(slug: string): Promise<void> {
  const config = loadConfig();
  const db = getDb(config);
  const ws = db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(slug) as
    | { id: number }
    | undefined;
  if (!ws) {
    console.error(`workspace '${slug}' not found`);
    process.exit(1);
  }
  const root = workspaceDir(config, slug);

  async function walk(dir: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const acc: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) acc.push(...(await walk(full)));
      else if (entry.isFile() && entry.name.endsWith(".md")) acc.push(full);
    }
    return acc;
  }

  const files = await walk(root);
  let updated = 0;
  for (const full of files) {
    const rel = path.relative(root, full);
    const content = await fs.readFile(full, "utf8");
    const result = indexDocument(db, ws.id, rel, content);
    if (result.rewrote) {
      const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, result.content, "utf8");
      await fs.rename(tmp, full);
      updated++;
    }
    console.log(`indexed ${rel} (${result.meta.id} ${result.meta.type}/${result.meta.status})`);
  }
  console.log(`done — ${files.length} files indexed, ${updated} rewritten`);
}

function help(): void {
  console.log(`Usage:
  cosheaf user add <username>
  cosheaf user passwd <username>
  cosheaf user list
  cosheaf user rm <username>
  cosheaf workspace add <slug> <name> --owner <username>
  cosheaf workspace member <slug> <username> <role>
  cosheaf workspace reindex <slug>
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, sub, ...rest] = argv;

  if (cmd === "user" && sub === "add" && rest[0]) return userAdd(rest[0]);
  if (cmd === "user" && sub === "passwd" && rest[0]) return userPasswd(rest[0]);
  if (cmd === "user" && sub === "list") return userList();
  if (cmd === "user" && sub === "rm" && rest[0]) return userRm(rest[0]);

  if (cmd === "workspace" && sub === "add" && rest.length >= 4) {
    const ownerIdx = rest.indexOf("--owner");
    if (ownerIdx === -1 || !rest[ownerIdx + 1]) {
      console.error("--owner <username> required");
      process.exit(1);
    }
    const slug = rest[0];
    const name = rest[1];
    const owner = rest[ownerIdx + 1];
    return workspaceAdd(slug, name, owner);
  }
  if (cmd === "workspace" && sub === "member" && rest.length === 3) {
    return workspaceMember(rest[0], rest[1], rest[2]);
  }
  if (cmd === "workspace" && sub === "reindex" && rest[0]) return workspaceReindex(rest[0]);

  help();
  process.exit(cmd ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
