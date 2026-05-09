export type DiffLine = { kind: "eq" | "add" | "del"; text: string };

export function stripFrontmatter(s: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(s);
  return m ? s.slice(m[0].length) : s;
}

/** Hard cap on the LCS table to keep memory bounded for huge inputs. */
const MAX_DP_CELLS = 4_000_000;

/** Line-oriented LCS diff. `del` lines are in `a` but not `b`; `add` is the reverse.
 * Falls back to a coarse all-del + all-add diff when inputs are too large for the LCS table. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const m = A.length;
  const n = B.length;
  if (m * n > MAX_DP_CELLS) {
    return [
      ...A.map((text): DiffLine => ({ kind: "del", text })),
      ...B.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ kind: "eq", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: A[i] });
      i++;
    } else {
      out.push({ kind: "add", text: B[j] });
      j++;
    }
  }
  while (i < m) out.push({ kind: "del", text: A[i++] });
  while (j < n) out.push({ kind: "add", text: B[j++] });
  return out;
}
