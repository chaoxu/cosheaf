#!/usr/bin/env node
import { Command } from "commander";

const program = new Command("api-smoke")
  .description("exercise the Cosheaf API flow used by agents")
  .option("--api <url>", "Cosheaf API base URL", process.env.COSHEAF_API_URL ?? "http://localhost:3030/api/v1")
  .option("--workspace <slug>", "workspace slug", process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin")
  .option("--admin-user <name>", "admin username", process.env.COSHEAF_SMOKE_USER ?? "chao")
  .option("--admin-password <password>", "admin password", process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!")
  .option("--reviewer-user <name>", "reviewer username", process.env.COSHEAF_REVIEWER_USER ?? "vera")
  .option("--reviewer-password <password>", "reviewer password", process.env.COSHEAF_REVIEWER_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!")
  .option("--keep-open", "leave the PR open instead of merging it", false)
  .parse(process.argv);

const opts = program.opts();
const apiBase = String(opts.api).replace(/\/$/, "");
const workspace = opts.workspace;
const stamp = Date.now();
const branch = `agent/api-smoke-${stamp}`;
const path = `agent-api-smoke-${stamp}.md`;
const title = `Agent API smoke ${stamp}`;

function apiUrl(pathname) {
  return `${apiBase}${pathname}`;
}

async function request(pathname, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(apiUrl(pathname), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      data = text;
    }
  }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function login(username, password) {
  const data = await request("/login", {
    method: "POST",
    body: { username, password },
  });
  if (!data?.pat) throw new Error(`login for ${username} did not return a PAT`);
  return data.pat;
}

async function main() {
  const adminPat = await login(opts.adminUser, opts.adminPassword);
  const reviewerPat = await login(opts.reviewerUser, opts.reviewerPassword);

  await request(`/w/${workspace}/branches`, {
    token: adminPat,
    method: "POST",
    body: { name: branch },
  });

  const content = [
    `# ${title}`,
    "",
    "This file was created by the Cosheaf API smoke.",
    "",
    "- typed file write should add frontmatter and update the sidecar index",
    "- typed pull routes should open and review a PR",
    "- typed merge should enforce Cosheaf's merge boundary",
    "",
  ].join("\n");
  const writeResult = await request(`/w/${workspace}/file?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`, {
    token: adminPat,
    method: "PUT",
    body: { content },
  });

  const search = await request(`/w/${workspace}/search?q=${encodeURIComponent(title)}`, {
    token: adminPat,
  });
  const indexed = search?.results?.some((row) => row.path === path);
  if (!indexed) throw new Error(`typed write did not show up in search index for ${path}`);

  const pull = await request(`/w/${workspace}/pulls`, {
    token: adminPat,
    method: "POST",
    body: {
      head: branch,
      base: "main",
      title,
      body: [
        "API smoke opened this PR through the Cosheaf API.",
        "",
        "The merge step uses Cosheaf's typed merge route.",
      ].join("\n"),
    },
  });
  const prNumber = pull?.number;
  if (!Number.isInteger(prNumber)) throw new Error("open PR response did not include a pull number");

  await request(`/w/${workspace}/pulls/${prNumber}/reviews`, {
    token: reviewerPat,
    method: "POST",
    body: { event: "APPROVE", body: "API smoke approval" },
  });

  if (!opts.keepOpen) {
    await request(`/w/${workspace}/pulls/${prNumber}/merge`, {
      token: adminPat,
      method: "POST",
      body: { Do: "squash" },
    });
    const merged = await request(`/w/${workspace}/file?path=${encodeURIComponent(path)}&branch=main`, {
      token: adminPat,
    });
    if (!merged?.content?.includes(title)) throw new Error(`merged file ${path} was not readable on main`);
  }

  console.log(JSON.stringify({
    ok: true,
    api: apiBase,
    workspace,
    branch,
    path,
    prNumber,
    cosheafId: writeResult?.meta?.id ?? null,
    merged: !opts.keepOpen,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
