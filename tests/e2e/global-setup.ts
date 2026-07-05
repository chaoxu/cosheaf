// Reset the dev workspace + seed a fresh in-review PR for full e2e runs.
// Focused read-only specs may set COSHEAF_E2E_RESET=0; the setup still writes
// a reusable authenticated storage state so specs do not have to log in via UI.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultWebUrl } from "../../scripts/lib/env-dev.mjs";

const webBase = defaultWebUrl();
const authStatePath = process.env.COSHEAF_E2E_STORAGE_STATE ?? ".playwright/cosheaf-chao-state.json";

function run(label: string, cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: process.cwd() });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

export default async function globalSetup(): Promise<void> {
  if (process.env.COSHEAF_E2E_RESET !== "0") {
    run("workspace rm", "pnpm", ["cli", "workspace", "rm", "chao/flushing-coin"]);
    run("setup:dev:review", "pnpm", ["setup:dev:review"]);
    await seedReviewablePr();
  }
  await writeAuthStorageState();
}

async function loginForPat(username: string, password: string): Promise<string> {
  const res = await fetch(`${webBase}/api/v1/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login ${username}: ${res.status}`);
  const body = (await res.json()) as { pat: string };
  return body.pat;
}

async function seedReviewablePr(): Promise<void> {
  const meriPat = await loginForPat("test-meri", "Cosheaf123!");

  const branch = "user/test-meri/e2e-demo";

  for (const file of [
    { path: "demo.md", content: "# Pythagoras\n\nIn a right triangle, a^2 + b^2 = c^2.\n\nProof: similar triangles.\n" },
    { path: "demo2.md", content: "# Companion\n\nA second file on the same branch.\n" },
  ]) {
    const put = await fetch(
      `${webBase}/api/v1/repos/chao/flushing-coin/file?path=${file.path}&branch=${encodeURIComponent(branch)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${meriPat}` },
        body: JSON.stringify({ content: file.content }),
      },
    );
    if (!put.ok) throw new Error(`seedReviewablePr putFile ${file.path}: ${put.status}`);
  }

  const opened = await fetch(`${webBase}/api/v1/repos/chao/flushing-coin/pulls`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${meriPat}` },
    body: JSON.stringify({ head: branch, title: "e2e demo PR" }),
  });
  if (!opened.ok) throw new Error(`seedReviewablePr openPull: ${opened.status}`);
  const { number: prNumber } = (await opened.json()) as { number: number };

  const veraPat = await loginForPat("test-vera", "Cosheaf123!");
  for (const comment of [
    { path: "demo.md", line: 5, body: "Should we cite Euclid's Elements I.47?" },
    { path: "demo2.md", line: 3, body: "This companion note needs a source." },
  ]) {
    const cmt = await fetch(
      `${webBase}/api/v1/repos/chao/flushing-coin/pulls/${prNumber}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${veraPat}` },
        body: JSON.stringify({
          path: comment.path,
          line: comment.line,
          side: "head",
          body: comment.body,
        }),
      },
    );
    if (!cmt.ok) throw new Error(`seedReviewablePr comment ${comment.path}: ${cmt.status}`);
  }
}

async function writeAuthStorageState(): Promise<void> {
  let pat: string;
  try {
    pat = await loginForPat("chao", "Cosheaf123!");
  } catch (error) {
    if (process.env.COSHEAF_E2E_RESET === "0") {
      run("setup:dev:review", "pnpm", ["setup:dev:review"]);
      pat = await loginForPat("chao", "Cosheaf123!");
    } else {
      throw error;
    }
  }
  const url = new URL(webBase);
  mkdirSync(path.dirname(authStatePath), { recursive: true });
  writeFileSync(authStatePath, JSON.stringify({
    cookies: [{
      name: "cosheaf_pat",
      value: pat,
      domain: url.hostname,
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
    }],
    origins: [{
      origin: url.origin,
      localStorage: [],
    }],
  }, null, 2));
}
