#!/usr/bin/env node

import { Command } from "commander";
import { defaultApiUrl, loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const program = new Command("tea-compat-check")
  .description("check the Cosheaf URL against the tea/Gitea endpoint subset agents use")
  .option("--api <url>", "Cosheaf API base URL", defaultApiUrl())
  .option("--workspace <owner/repo>", "workspace to probe", process.env.COSHEAF_WORKSPACE ?? "chao/flushing-coin")
  .option("--username <name>", "Cosheaf login username", process.env.COSHEAF_SMOKE_USER ?? "chao")
  .option("--password <password>", "Cosheaf login password", process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!")
  .option("--write-check", "create and clean up a temporary branch/file through /contents", false)
  .option("--json", "emit machine-readable JSON", false)
  .parse(normalizeArgv(process.argv));

const opts = program.opts();
const apiBase = String(opts.api).replace(/\/+$/, "");
const workspace = parseWorkspace(opts.workspace);

function parseWorkspace(value) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new Error("--workspace must be <owner>/<repo>");
  const [owner, repo] = value.split("/");
  return { owner, repo, slug: value };
}

async function request(path, { token, method = "GET", body, authScheme = "Bearer" } = {}) {
  const headers = {};
  if (token) headers.authorization = `${authScheme} ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${apiBase}${path}`, {
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
  return { status: res.status, ok: res.ok, data };
}

async function login() {
  const res = await request("/login", {
    method: "POST",
    body: { username: opts.username, password: opts.password },
  });
  if (!res.ok || typeof res.data?.pat !== "string") {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.pat;
}

function endpoint(name, path, { token = true, expect = [200], note = "" } = {}) {
  return { name, path, token, expect, note };
}

function resultFromResponse(item, res) {
  return {
    name: item.name,
    path: item.path,
    status: res.status,
    ok: item.expect.includes(res.status),
    note: item.note,
  };
}

async function main() {
  const token = await login();
  const endpoints = [
    endpoint("version", "/version", { token: false, note: "required by tea login/version detection" }),
    endpoint("current user", "/user", { note: "required by tea login/whoami" }),
    endpoint("current user (tea auth)", "/user", { note: "Gitea/tea Authorization: token support" }),
    endpoint("repo metadata", `/repos/${workspace.slug}`, { note: "tea repo context" }),
    endpoint("branches", `/repos/${workspace.slug}/branches`, { note: "tea branches list" }),
    endpoint("pulls", `/repos/${workspace.slug}/pulls?state=open`, { note: "tea pulls list" }),
    endpoint("issues", `/repos/${workspace.slug}/issues?state=open`, { note: "tea issues list" }),
    endpoint("labels", `/repos/${workspace.slug}/labels`, { note: "tea labels list" }),
    endpoint("milestones", `/repos/${workspace.slug}/milestones?state=open`, { note: "tea milestones list" }),
    endpoint("contents", `/repos/${workspace.slug}/contents/hello.md?ref=main`, {
      expect: [200],
      note: "standard tea/Gitea file read translated through Cosheaf",
    }),
  ];

  const results = [];
  for (const item of endpoints) {
    const res = await request(item.path, {
      token: item.token ? token : undefined,
      authScheme: item.name === "current user (tea auth)" ? "token" : "Bearer",
    });
    results.push(resultFromResponse(item, res));
  }

  if (opts.writeCheck) {
    const branch = `tea-compat-${Date.now()}`;
    const filePath = `tea-compat-${Date.now()}.md`;
    const writePath = `/repos/${workspace.slug}/contents/${filePath}`;
    const content = Buffer.from(`# Tea compatibility\n\nTemporary write probe.\n`, "utf8").toString("base64");
    const write = await request(writePath, {
      token,
      method: "POST",
      body: {
        branch: "main",
        new_branch: branch,
        message: "tea compatibility write probe",
        content,
      },
    });
    results.push(resultFromResponse(endpoint("contents write", writePath, {
      expect: [201],
      note: "standard tea/Gitea file create translated through Cosheaf",
    }), write));
    const writtenSha = write.data?.content?.sha;
    if (typeof writtenSha === "string") {
      const del = await request(writePath, {
        token,
        method: "DELETE",
        body: {
          branch,
          message: "cleanup tea compatibility write probe",
          sha: writtenSha,
        },
      });
      results.push(resultFromResponse(endpoint("contents delete", writePath, {
        expect: [200],
        note: "cleanup temporary file through standard tea/Gitea delete",
      }), del));
    }
    const deleteBranch = await request(`/repos/${workspace.slug}/branches/${encodeURIComponent(branch)}`, {
      token,
      method: "DELETE",
    });
    results.push(resultFromResponse(endpoint("branch cleanup", `/repos/${workspace.slug}/branches/${branch}`, {
      expect: [200],
      note: "cleanup temporary branch",
    }), deleteBranch));
  }

  const summary = {
    api: apiBase,
    workspace: workspace.slug,
    completeTeaMatch: results.every((row) => row.ok),
    results,
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Cosheaf tea compatibility: ${summary.completeTeaMatch ? "complete" : "incomplete"}`);
  for (const row of results) {
    console.log(`${row.ok ? "OK" : "GAP"} ${row.name}: ${row.status} ${row.path}`);
    if (row.note) console.log(`  ${row.note}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function normalizeArgv(argv) {
  return argv.filter((arg, index) => index < 2 || arg !== "--");
}
