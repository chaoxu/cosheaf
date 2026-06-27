import { diffWordsWithSpace } from "diff";
import type { SourceSplitCell } from "./source-split-rows.js";

export interface SourceLineMatch {
  base: SourceSplitCell | null;
  head: SourceSplitCell | null;
}

const MIN_MATCH_SIMILARITY = 0.45;
const LINE_MATCH_LOOKAHEAD = 24;
const SKIP_DISTANCE_PENALTY = 0.1;

interface CandidateMatch {
  baseIndex: number;
  headIndex: number;
  score: number;
}

interface LineProfile {
  tokens: readonly string[];
}

export function matchSourceLines(baseLines: readonly SourceSplitCell[], headLines: readonly SourceSplitCell[]): SourceLineMatch[] {
  if (baseLines.length === 0) return headLines.map((head) => ({ base: null, head }));
  if (headLines.length === 0) return baseLines.map((base) => ({ base, head: null }));
  if (baseLines.length === 1 && headLines.length === 1) return [{ base: baseLines[0], head: headLines[0] }];

  const allowPositionalFallback = baseLines.length === headLines.length;
  const baseProfiles = baseLines.map((line) => lineProfile(line.text));
  const headProfiles = headLines.map((line) => lineProfile(line.text));
  const out: SourceLineMatch[] = [];
  let i = 0;
  let j = 0;
  while (i < baseLines.length || j < headLines.length) {
    if (i >= baseLines.length) {
      out.push({ base: null, head: headLines[j++] });
      continue;
    }
    if (j >= headLines.length) {
      out.push({ base: baseLines[i++], head: null });
      continue;
    }

    const candidate = bestLocalMatch(baseLines, headLines, baseProfiles, headProfiles, i, j);
    if (candidate) {
      while (i < candidate.baseIndex) out.push({ base: baseLines[i++], head: null });
      while (j < candidate.headIndex) out.push({ base: null, head: headLines[j++] });
      out.push({ base: baseLines[i++], head: headLines[j++] });
      continue;
    }

    const remainingBase = baseLines.length - i;
    if (remainingBase === headLines.length - j && allowPositionalFallback) {
      out.push({ base: baseLines[i++], head: headLines[j++] });
    } else if (remainingBase > 0) {
      out.push({ base: baseLines[i++], head: null });
    } else {
      out.push({ base: null, head: headLines[j++] });
    }
  }
  return out;
}

function bestLocalMatch(
  baseLines: readonly SourceSplitCell[],
  headLines: readonly SourceSplitCell[],
  baseProfiles: readonly LineProfile[],
  headProfiles: readonly LineProfile[],
  baseStart: number,
  headStart: number,
): CandidateMatch | null {
  const baseEnd = Math.min(baseLines.length, baseStart + LINE_MATCH_LOOKAHEAD);
  const headEnd = Math.min(headLines.length, headStart + LINE_MATCH_LOOKAHEAD);
  let best: CandidateMatch | null = null;
  for (let baseIndex = baseStart; baseIndex < baseEnd; baseIndex += 1) {
    for (let headIndex = headStart; headIndex < headEnd; headIndex += 1) {
      if (quickLineSimilarity(baseProfiles[baseIndex], headProfiles[headIndex]) < MIN_MATCH_SIMILARITY) continue;
      const score = sourceLineSimilarity(baseLines[baseIndex].text, headLines[headIndex].text);
      if (score < MIN_MATCH_SIMILARITY) continue;
      const candidate = { baseIndex, headIndex, score };
      if (!best || isBetterCandidate(candidate, best, baseStart, headStart)) best = candidate;
    }
  }
  return best;
}

function isBetterCandidate(candidate: CandidateMatch, best: CandidateMatch, baseStart: number, headStart: number): boolean {
  const candidateScore = candidate.score - SKIP_DISTANCE_PENALTY * candidateDistance(candidate, baseStart, headStart);
  const bestScore = best.score - SKIP_DISTANCE_PENALTY * candidateDistance(best, baseStart, headStart);
  if (candidateScore !== bestScore) return candidateScore > bestScore;
  if (candidate.score !== best.score) return candidate.score > best.score;
  const distance = candidateDistance(candidate, baseStart, headStart);
  const bestDistance = candidateDistance(best, baseStart, headStart);
  if (distance !== bestDistance) return distance < bestDistance;
  if (candidate.baseIndex !== best.baseIndex) return candidate.baseIndex < best.baseIndex;
  return candidate.headIndex < best.headIndex;
}

function candidateDistance(candidate: CandidateMatch, baseStart: number, headStart: number): number {
  return candidate.baseIndex - baseStart + candidate.headIndex - headStart;
}

function lineProfile(value: string): LineProfile {
  return { tokens: lineTokens(value) };
}

function quickLineSimilarity(base: LineProfile, head: LineProfile): number {
  if (base.tokens.length === 0 || head.tokens.length === 0) return 0;
  const headCounts = new Map<string, number>();
  for (const token of head.tokens) headCounts.set(token, (headCounts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of base.tokens) {
    const count = headCounts.get(token) ?? 0;
    if (count === 0) continue;
    shared += 1;
    if (count === 1) headCounts.delete(token);
    else headCounts.set(token, count - 1);
  }
  return (2 * shared) / (base.tokens.length + head.tokens.length);
}

function lineTokens(value: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const char of value.toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(char) && !/\p{Script=Han}/u.test(char)) {
      word += char;
      continue;
    }
    if (word) {
      out.push(word);
      word = "";
    }
    if (/\p{Script=Han}/u.test(char)) out.push(char);
  }
  if (word) out.push(word);
  return out;
}

export function sourceLineSimilarity(base: string, head: string): number {
  if (base === head) return 1;
  const left = base.trim();
  const right = head.trim();
  if (left === right) return 1;
  if (!left || !right) return 0;

  const changes = diffWordsWithSpace(left, right);
  let equalChars = 0;
  let baseChars = 0;
  let headChars = 0;
  for (const change of changes) {
    const width = contentWidth(change.value);
    if (change.added) headChars += width;
    else if (change.removed) baseChars += width;
    else {
      equalChars += width;
      baseChars += width;
      headChars += width;
    }
  }
  const total = baseChars + headChars;
  return total === 0 ? 0 : (2 * equalChars) / total;
}

function contentWidth(value: string): number {
  return Array.from(value).filter((char) => !/\s/u.test(char)).length;
}
