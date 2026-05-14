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
  // Publish one in-review change as meri so the pr-view spec has a PR to open.
  await seedReviewablePr();
}

async function seedReviewablePr(): Promise<void> {
  const login = await fetch("http://localhost:3030/api/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "meri", password: "123123" }),
  });
  const cookie = login.headers.get("set-cookie") ?? "";

  const put = await fetch(
    "http://localhost:3030/api/v1/w/flushing-coin/file?path=demo.md",
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        content:
          "# Pythagoras\n\nIn a right triangle, a^2 + b^2 = c^2.\n\nProof: similar triangles.\n",
      }),
    },
  );
  if (!put.ok) throw new Error(`seedReviewablePr putFile: ${put.status}`);
  const { change_id } = (await put.json()) as { change_id: string };

  const put2 = await fetch(
    "http://localhost:3030/api/v1/w/flushing-coin/file?path=demo2.md",
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        content: "# Companion\n\nA second file in the same change.\n",
      }),
    },
  );
  if (!put2.ok) throw new Error(`seedReviewablePr putFile2: ${put2.status}`);

  const pub = await fetch(
    "http://localhost:3030/api/v1/w/flushing-coin/publish",
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ change_id, mode: "review" }),
    },
  );
  if (!pub.ok) throw new Error(`seedReviewablePr publish: ${pub.status}`);

  // Login as vera and seed a comment so the pr-view spec has something to
  // assert against.
  const vlogin = await fetch("http://localhost:3030/api/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "vera", password: "123123" }),
  });
  const vcookie = vlogin.headers.get("set-cookie") ?? "";
  const cmt = await fetch(
    `http://localhost:3030/api/v1/w/flushing-coin/change/${change_id}/comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: vcookie },
      body: JSON.stringify({
        path: "demo.md",
        line: 5,
        side: "new",
        body: "Should we cite Euclid's Elements I.47?",
      }),
    },
  );
  if (!cmt.ok) throw new Error(`seedReviewablePr comment: ${cmt.status}`);
}
