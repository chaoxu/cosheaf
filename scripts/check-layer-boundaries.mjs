#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const MODULE_FILE_RE = /\.(?:[cm]?[jt]sx?|d\.[cm]?[jt]s)$/;
const DECLARATION_FILE_RE = /\.d\.[cm]?[jt]s$/;
const TEST_FILE_RE = /(?:^|[./-])(?:[^/]*\.)?(?:test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export const LAYER_RULES = [
  {
    name: "shared must not import app layers",
    from: ["shared"],
    to: ["server", "src", "scripts"],
  },
  {
    name: "server must not import browser islands",
    from: ["server"],
    to: ["src"],
  },
  {
    name: "browser islands must not import server code",
    from: ["src"],
    to: ["server"],
  },
];

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function relativeToRepo(repoRoot, filePath) {
  return toPosixPath(path.relative(repoRoot, filePath));
}

function isModuleFile(filePath) {
  return MODULE_FILE_RE.test(filePath);
}

function isRuntimeSourceFile(filePath) {
  const normalized = toPosixPath(filePath);
  return isModuleFile(filePath) && !DECLARATION_FILE_RE.test(normalized) && !TEST_FILE_RE.test(normalized);
}

function walkDirectory(rootDir) {
  const entries = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir || !fs.existsSync(currentDir)) continue;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && isRuntimeSourceFile(entryPath)) entries.push(entryPath);
    }
  }
  return entries.sort();
}

function getLineNumber(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function collectModuleSpecifiers(sourceText, filePath) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push({ specifier: node.moduleSpecifier.text, line: getLineNumber(sourceFile, node.moduleSpecifier) });
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push({ specifier: node.arguments[0].text, line: getLineNumber(sourceFile, node.arguments[0]) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function layerForRepoPath(repoPath) {
  const [first, second] = repoPath.split("/");
  if (first === "src") return second ? `src/${second}` : "src";
  return first ?? "";
}

function layerMatches(layer, expected) {
  return layer === expected || layer.startsWith(`${expected}/`);
}

function resolveFileCandidate(candidate) {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  const sourceExtension = SOURCE_EXTENSIONS.find((extension) => candidate.endsWith(extension));
  if (sourceExtension) {
    const withoutExtension = candidate.slice(0, -sourceExtension.length);
    for (const extension of SOURCE_EXTENSIONS) {
      const withSwappedExtension = `${withoutExtension}${extension}`;
      if (fs.existsSync(withSwappedExtension) && fs.statSync(withSwappedExtension).isFile()) return withSwappedExtension;
    }
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const withExtension = `${candidate}${extension}`;
    if (fs.existsSync(withExtension) && fs.statSync(withExtension).isFile()) return withExtension;
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const indexCandidate = path.join(candidate, `index${extension}`);
    if (fs.existsSync(indexCandidate) && fs.statSync(indexCandidate).isFile()) return indexCandidate;
  }
  return null;
}

export function resolveRepoModulePath(specifier, importerPath, repoRoot) {
  if (specifier.startsWith(".")) {
    return resolveFileCandidate(path.resolve(path.dirname(importerPath), specifier));
  }
  if (
    specifier === "server" ||
    specifier === "src" ||
    specifier === "shared" ||
    specifier === "scripts" ||
    specifier.startsWith("server/") ||
    specifier.startsWith("src/") ||
    specifier.startsWith("shared/") ||
    specifier.startsWith("scripts/")
  ) {
    return resolveFileCandidate(path.join(repoRoot, specifier));
  }
  return null;
}

function ruleApplies(rule, importerLayer) {
  return rule.from.some((fromLayer) => layerMatches(importerLayer, fromLayer));
}

function ruleIsViolated(rule, targetLayer) {
  return rule.to.some((toLayer) => layerMatches(targetLayer, toLayer));
}

export function findLayerBoundaryViolations(entries, repoRoot, rules = LAYER_RULES) {
  const violations = [];
  for (const entry of entries) {
    const filePath = path.resolve(entry.filePath);
    const repoPath = relativeToRepo(repoRoot, filePath);
    const importerLayer = layerForRepoPath(repoPath);
    const applicableRules = rules.filter((rule) => ruleApplies(rule, importerLayer));
    if (applicableRules.length === 0) continue;

    const sourceText = entry.sourceText ?? fs.readFileSync(filePath, "utf8");
    for (const importEntry of collectModuleSpecifiers(sourceText, filePath)) {
      const targetPath = resolveRepoModulePath(importEntry.specifier, filePath, repoRoot);
      if (!targetPath) continue;
      const targetLayer = layerForRepoPath(relativeToRepo(repoRoot, targetPath));
      for (const rule of applicableRules) {
        if (!ruleIsViolated(rule, targetLayer)) continue;
        violations.push({
          filePath,
          line: importEntry.line,
          rule: rule.name,
          specifier: importEntry.specifier,
          targetPath,
        });
      }
    }
  }
  return violations;
}

function collectEntries(repoRoot) {
  return ["server", "src", "shared", "scripts"]
    .flatMap((dir) => walkDirectory(path.join(repoRoot, dir)))
    .map((filePath) => ({ filePath }));
}

function formatViolation(violation, repoRoot) {
  const filePath = relativeToRepo(repoRoot, violation.filePath);
  const targetPath = relativeToRepo(repoRoot, violation.targetPath);
  return `${filePath}:${violation.line} imports ${JSON.stringify(violation.specifier)} -> ${targetPath}`;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    console.error("check-layer-boundaries.mjs does not accept arguments");
    return 1;
  }
  const repoRoot = process.cwd();
  const violations = findLayerBoundaryViolations(collectEntries(repoRoot), repoRoot);
  if (violations.length === 0) return 0;
  console.error("Layer boundary violation(s) found:");
  for (const violation of violations) {
    console.error(`- ${violation.rule}: ${formatViolation(violation, repoRoot)}`);
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
