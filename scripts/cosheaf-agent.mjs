#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { defaultApiUrl, loadDotenvDev } from "./lib/env-dev.mjs";

class HttpError extends Error {
  constructor(message, { status, data }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.data = data;
  }
}

export function parseWorkspace(value) {
  if (typeof value !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new Error("--workspace must be <owner>/<repo>.");
  }
  const [owner, repo] = value.split("/");
  return { owner, repo, slug: value };
}

export function parseFileSpec(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("--file requires a value.");
  }
  const separator = value.indexOf("=");
  const workspacePath = separator === -1 ? value : value.slice(0, separator);
  const localPath = separator === -1 ? value : value.slice(separator + 1);
  if (!workspacePath || !localPath) {
    throw new Error("--file must be <workspace-path> or <workspace-path>=<local-path>.");
  }
  if (workspacePath.startsWith("/") || workspacePath.split("/").includes("..")) {
    throw new Error(`Invalid workspace path for --file: ${workspacePath}`);
  }
  return { workspacePath, localPath };
}

export function normalizeApiBase(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error("--api is required.");
  return trimmed.replace(/\/+$/, "");
}

export function tokenFromOptions(options, env = process.env) {
  const token = options.token ?? env.COSHEAF_TOKEN ?? env.COSHEAF_PAT ?? env.COSHEAF_API_TOKEN ?? "";
  if (!token.trim()) {
    throw new Error("A Cosheaf API token is required. Pass --token or set COSHEAF_TOKEN.");
  }
  return token;
}

export function loadPrFiles(fileSpecs, readFile = readFileSync) {
  if (!Array.isArray(fileSpecs) || fileSpecs.length === 0) {
    throw new Error("pr-from-files requires at least one --file.");
  }
  return fileSpecs.map((spec) => {
    const parsed = parseFileSpec(spec);
    return {
      ...parsed,
      content: readFile(parsed.localPath, "utf8"),
    };
  });
}

function workspacePath(workspace) {
  const { owner, repo } = parseWorkspace(workspace);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function jsonHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function request(apiBase, pathname, { token, method = "GET", body } = {}) {
  const headers = token ? jsonHeaders(token) : {};
  if (body === undefined) delete headers["content-type"];
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      data = text;
    }
  }
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new HttpError(`${method} ${pathname} -> ${response.status}: ${detail}`, {
      status: response.status,
      data,
    });
  }
  return data;
}

async function createBranch(apiBase, workspace, token, branch) {
  try {
    await request(apiBase, `${workspacePath(workspace)}/branches`, {
      token,
      method: "POST",
      body: { name: branch },
    });
    return { created: true };
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      return { created: false };
    }
    throw error;
  }
}

async function writeFile(apiBase, workspace, token, file, branch) {
  const query = new URLSearchParams({ path: file.workspacePath, branch });
  const result = await request(apiBase, `${workspacePath(workspace)}/file?${query.toString()}`, {
    token,
    method: "PUT",
    body: { content: file.content },
  });
  return {
    path: file.workspacePath,
    localPath: file.localPath,
    cosheafId: result?.meta?.id ?? null,
  };
}

async function findOpenPull(apiBase, workspace, token, { head, base }) {
  const query = new URLSearchParams({ state: "open" });
  const data = await request(apiBase, `${workspacePath(workspace)}/pulls?${query.toString()}`, { token });
  const pulls = Array.isArray(data?.pulls) ? data.pulls : [];
  return pulls.find((pull) => pull?.head_ref === head && pull?.base_ref === base && !pull?.merged) ?? null;
}

async function openPull(apiBase, workspace, token, payload) {
  const existing = await findOpenPull(apiBase, workspace, token, payload);
  if (existing) return { pull: existing, reused: true };
  try {
    const pull = await request(apiBase, `${workspacePath(workspace)}/pulls`, {
      token,
      method: "POST",
      body: payload,
    });
    return { pull, reused: false };
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      const retryExisting = await findOpenPull(apiBase, workspace, token, payload);
      if (retryExisting) return { pull: retryExisting, reused: true };
    }
    throw error;
  }
}

export async function prFromFiles(options) {
  const apiBase = normalizeApiBase(options.api);
  const workspace = parseWorkspace(options.workspace).slug;
  const base = options.base ?? "main";
  const files = loadPrFiles(options.file);
  if (!options.branch) throw new Error("--branch is required.");
  if (!options.title) throw new Error("--title is required.");

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      api: apiBase,
      workspace,
      branch: options.branch,
      base,
      title: options.title,
      files: files.map(({ workspacePath, localPath }) => ({ path: workspacePath, localPath })),
    };
  }

  const token = tokenFromOptions(options);
  const branchResult = await createBranch(apiBase, workspace, token, options.branch);
  const written = [];
  for (const file of files) {
    written.push(await writeFile(apiBase, workspace, token, file, options.branch));
  }
  const pullResult = await openPull(apiBase, workspace, token, {
    head: options.branch,
    base,
    title: options.title,
    body: options.body ?? "",
  });
  const number = pullResult.pull?.number ?? null;
  return {
    ok: true,
    api: apiBase,
    workspace,
    branch: options.branch,
    branchCreated: branchResult.created,
    base,
    files: written,
    pull: {
      number,
      reused: pullResult.reused,
      path: number === null ? null : `/${workspace}/pulls/${number}`,
    },
  };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.dryRun) {
    console.log(`Would write ${result.files.length} file(s) to ${result.workspace}:${result.branch}`);
    console.log(`Would open PR '${result.title}' into ${result.base}`);
    return;
  }
  console.log(`Wrote ${result.files.length} file(s) to ${result.workspace}:${result.branch}`);
  if (result.pull?.reused) {
    console.log(`Reused PR #${result.pull.number}: ${result.pull.path}`);
  } else {
    console.log(`Opened PR #${result.pull.number}: ${result.pull.path}`);
  }
}

export function buildProgram() {
  const program = new Command("cosheaf-tea")
    .description("tea-shaped Cosheaf typed API helper for AI clients")
    .option("--api <url>", "Cosheaf API base URL", defaultApiUrl())
    .option("--workspace <owner/repo>", "Cosheaf workspace", process.env.COSHEAF_WORKSPACE)
    .option("--token <token>", "Cosheaf API token; defaults to COSHEAF_TOKEN, COSHEAF_PAT, or COSHEAF_API_TOKEN")
    .option("--json", "print machine-readable JSON", false);

  program
    .command("pr-from-files")
    .description("write local files to a Cosheaf branch and open or reuse a PR")
    .requiredOption("--branch <name>", "Cosheaf branch to write")
    .requiredOption("--title <title>", "pull request title")
    .option("--base <name>", "base branch", "main")
    .option("--body <text>", "pull request body", "")
    .option("--file <workspace-path[=local-path]>", "file to upload; repeatable", (value, previous) => [
      ...(previous ?? []),
      value,
    ])
    .option("--dry-run", "print the planned writes without calling Cosheaf", false)
    .action(async (opts) => {
      const globals = program.opts();
      const result = await prFromFiles({ ...globals, ...opts });
      printResult(result, globals.json);
    });

  return program;
}

export async function main(argv = process.argv) {
  loadDotenvDev();
  await buildProgram().parseAsync(normalizeArgv(argv));
}

function normalizeArgv(argv) {
  return argv.filter((arg, index) => index < 2 || arg !== "--");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
