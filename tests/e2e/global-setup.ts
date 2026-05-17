// Reset the dev workspace + seed a fresh in-review PR before each test
// run, so e2e specs don't accumulate files in the Forgejo repo across runs.

import { spawnSync } from "node:child_process";

function run(label: string, cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: process.cwd() });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

export default async function globalSetup(): Promise<void> {
  run("workspace rm", "pnpm", ["cli", "workspace", "rm", "flushing-coin"]);
  run("setup:dev:review", "pnpm", ["setup:dev:review"]);
  await seedReviewablePr();
}

async function seedReviewablePr(): Promise<void> {
  const login = await fetch("http://localhost:3030/api/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "meri", password: "Cosheaf123!" }),
  });
  const cookie = login.headers.get("set-cookie") ?? "";

  const branch = "user/meri/e2e-demo";

  for (const file of [
    { path: "demo.md", content: "# Pythagoras\n\nIn a right triangle, a^2 + b^2 = c^2.\n\nProof: similar triangles.\n" },
    { path: "demo2.md", content: "# Companion\n\nA second file on the same branch.\n" },
  ]) {
    const put = await fetch(
      `http://localhost:3030/api/v1/w/flushing-coin/file?path=${file.path}&branch=${encodeURIComponent(branch)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ content: file.content }),
      },
    );
    if (!put.ok) throw new Error(`seedReviewablePr putFile ${file.path}: ${put.status}`);
  }

  const opened = await fetch("http://localhost:3030/api/v1/w/flushing-coin/pulls", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ head: branch, title: "e2e demo PR" }),
  });
  if (!opened.ok) throw new Error(`seedReviewablePr openPull: ${opened.status}`);
  const { number: prNumber } = (await opened.json()) as { number: number };

  const vlogin = await fetch("http://localhost:3030/api/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "vera", password: "Cosheaf123!" }),
  });
  const vcookie = vlogin.headers.get("set-cookie") ?? "";
  for (const comment of [
    { path: "demo.md", line: 5, body: "Should we cite Euclid's Elements I.47?" },
    { path: "demo2.md", line: 3, body: "This companion note needs a source." },
  ]) {
    const cmt = await fetch(
      `http://localhost:3030/api/v1/w/flushing-coin/pulls/${prNumber}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: vcookie },
        body: JSON.stringify({
          path: comment.path,
          line: comment.line,
          side: "new",
          body: comment.body,
        }),
      },
    );
    if (!cmt.ok) throw new Error(`seedReviewablePr comment ${comment.path}: ${cmt.status}`);
  }
}
