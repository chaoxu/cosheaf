import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLatexPandocArgs,
  buildPandocResourcePath,
  exportDependencyTools,
  LATEX_CSL_NAMES,
  LATEX_TEMPLATE_NAMES,
  latexConfigWithDefaults,
  parseLatexFrontmatterConfig,
  preprocessWithReadFile,
  resolveLatexCslPath,
  resolveLatexExportOptions,
  resolveLatexTemplatePath,
} from "@chaoxu/coflat/latex";
import { AsyncJobLimiter, type AsyncJobLimiterConfig } from "./async-job-limiter.js";
import { safeRel } from "./routes/files.js";

export interface PdfProjectFile {
  readonly path: string;
  readonly content: Buffer;
}

export interface PdfExportResult {
  readonly pdf: Buffer;
  readonly filename: string;
}

interface PandocExportBase {
  readonly source: string;
  readonly sourcePath: string;
  readonly defaults?: {
    readonly bibliography?: string;
    readonly csl?: string;
    readonly template?: string;
  };
  readonly flags?: {
    readonly bibliography?: unknown;
    readonly csl?: unknown;
    readonly template?: unknown;
  };
}

interface ExportCoflatPdfOptions extends PandocExportBase {
  readonly files: readonly PdfProjectFile[];
  readonly rateLimitKey?: string;
}

// Local Workbench export: pandoc runs directly against the on-disk working tree
// at `rootDir` instead of a materialized copy of the repo, so a big repo no
// longer has to be snapshotted into a temp dir just to render one document.
interface ExportCoflatPdfInPlaceOptions extends PandocExportBase {
  readonly rootDir: string;
}

// Where pandoc reads, resolves, and writes for one export. The two export modes
// differ only in how these paths are anchored: the hosted copy points them all
// at a temp materialization root; the local in-place mode anchors resolution at
// the real working tree and keeps only the preprocessed input + output in temp.
interface PandocPdfLayout {
  // pandoc cwd; base for relative template/csl resolution.
  readonly sourceDir: string;
  // resource-path project root (searched for images/includes/bibliography).
  readonly projectRoot: string;
  // absolute path to write the preprocessed source before invoking pandoc.
  readonly inputFile: string;
  // absolute path pandoc writes the PDF to.
  readonly outputFile: string;
  // Isolated scratch dir: holds the preprocessed input + output PDF, is the
  // dependency-probe cwd, and anchors LaTeX scratch (HOME/TMPDIR/TEXMFOUTPUT).
  readonly workDir: string;
}

interface CommandOptions {
  readonly cwd: string;
  // Directory used to anchor HOME/TMPDIR/TEXMFOUTPUT for the child (so LaTeX
  // scratch stays here, not under cwd). Defaults to cwd.
  readonly scratchDir?: string;
  readonly timeoutMs?: number;
}

type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<void>;

let commandRunnerForTest: CommandRunner | null = null;
let limiterConfigForTest: AsyncJobLimiterConfig | null = null;

const DEPENDENCY_CHECK_TIMEOUT_MS = 10_000;
const PDF_EXPORT_TIMEOUT_MS = 120_000;
const MAX_PDF_OUTPUT_BYTES = 100 * 1024 * 1024;
const DEFAULT_PDF_EXPORT_CONCURRENCY = 1;
const DEFAULT_PDF_EXPORT_QUEUE_LIMIT = 4;
const DEFAULT_PDF_EXPORT_COOLDOWN_MS = 30_000;

export interface PdfExportMetrics {
  readonly active: number;
  readonly queued: number;
  readonly concurrency: number;
  readonly queue_limit: number;
}

const pdfExportLimiter = new AsyncJobLimiter<PdfExportError>({
  config: pdfExportLimiterConfig,
  duplicateError: () => new PdfExportError(429, "PDF export is already running or was requested recently."),
  queueFullError: () => new PdfExportError(503, "PDF export queue is full. Try again shortly."),
});

export function _setPdfExportCommandRunnerForTest(runner: CommandRunner | null): void {
  commandRunnerForTest = runner;
}

export function _setPdfExportLimiterConfigForTest(config: AsyncJobLimiterConfig | null): void {
  limiterConfigForTest = config;
}

export function _resetPdfExportLimiterForTest(): void {
  pdfExportLimiter.reset();
  limiterConfigForTest = null;
}

export class PdfExportError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly detail?: string,
  ) {
    super(detail ? `${publicMessage}\n${detail}` : publicMessage);
  }
}

export async function exportCoflatMarkdownPdf(options: ExportCoflatPdfOptions): Promise<PdfExportResult> {
  if (!options.rateLimitKey) return exportCoflatMarkdownPdfUnbounded(options);
  return pdfExportLimiter.run(options.rateLimitKey, () => exportCoflatMarkdownPdfUnbounded(options));
}

export async function withPdfExportLimit<T>(rateLimitKey: string | undefined, run: () => Promise<T>): Promise<T> {
  return pdfExportLimiter.run(rateLimitKey, run);
}

export function pdfExportMetrics(): PdfExportMetrics {
  const metrics = pdfExportLimiter.metrics();
  return {
    active: metrics.active,
    queued: metrics.queued,
    concurrency: metrics.concurrency,
    queue_limit: metrics.queueLimit,
  };
}

async function exportCoflatMarkdownPdfUnbounded(options: ExportCoflatPdfOptions): Promise<PdfExportResult> {
  const sourceRel = safeRel(options.sourcePath);
  if (!sourceRel) {
    throw new PdfExportError(400, "Invalid document path.");
  }

  const root = await mkdtemp(path.join(tmpdir(), "cosheaf-pdf-"));
  try {
    await materializeProject(root, options.files);
    const inputFile = path.join(root, sourceRel);
    return await runPandocPdfExport(
      {
        projectRoot: root,
        sourceDir: path.dirname(inputFile),
        inputFile,
        outputFile: path.join(root, `${path.basename(sourceRel, path.extname(sourceRel))}.pdf`),
        workDir: root,
      },
      options,
      sourceRel,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Render a single document from the local working tree without copying the
// repo. pandoc runs with cwd/resource-path anchored at the real tree so
// relative images, includes, bibliography, and templates resolve on disk; only
// the preprocessed input and the output PDF live in a scratch dir.
export async function exportCoflatMarkdownPdfInPlace(
  options: ExportCoflatPdfInPlaceOptions,
): Promise<PdfExportResult> {
  const sourceRel = safeRel(options.sourcePath);
  if (!sourceRel) {
    throw new PdfExportError(400, "Invalid document path.");
  }

  const projectRoot = path.resolve(options.rootDir);
  const sourceDir = path.dirname(path.join(projectRoot, sourceRel));
  const work = await mkdtemp(path.join(tmpdir(), "cosheaf-pdf-"));
  try {
    return await runPandocPdfExport(
      {
        projectRoot,
        sourceDir,
        inputFile: path.join(work, path.basename(sourceRel)),
        outputFile: path.join(work, `${path.basename(sourceRel, path.extname(sourceRel))}.pdf`),
        workDir: work,
      },
      options,
      sourceRel,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function runPandocPdfExport(
  layout: PandocPdfLayout,
  options: PandocExportBase,
  sourceRel: string,
): Promise<PdfExportResult> {
  await checkPdfDependencies(layout.workDir);

  const preprocessed = await preprocessWithReadFile(options.source);
  await mkdir(path.dirname(layout.inputFile), { recursive: true });
  await writeFile(layout.inputFile, preprocessed, "utf8");

  const latexDir = path.dirname(fileURLToPath(import.meta.resolve("@chaoxu/coflat/latex/filter.lua")));
  const config = latexConfigWithDefaults(parseLatexFrontmatterConfig(options.source), options.defaults);
  const exportOptions = resolveLatexExportOptions({ config, flags: options.flags ?? {} });
  const template = resolveTemplatePath(exportOptions.template, {
    latexDir,
    root: layout.projectRoot,
    sourceDir: layout.sourceDir,
  });
  const csl = resolveCslPath(exportOptions.csl, {
    latexDir,
    root: layout.projectRoot,
    sourceDir: layout.sourceDir,
  });
  const args = [
    ...buildLatexPandocArgs({
      bibliography: exportOptions.bibliography,
      cslPath: csl,
      filterPath: path.join(latexDir, "filter.lua"),
      format: "pdf",
      output: layout.outputFile,
      resourcePath: buildPandocResourcePath(layout.projectRoot, layout.sourceDir),
      template,
    }),
    layout.inputFile,
  ];

  // cwd stays at the real source dir so relative resources resolve, but LaTeX
  // scratch (tex2pdf.*, aux files) is anchored at the isolated work dir so it
  // never lands in — or is orphaned in — the user's working tree.
  await runCommand("pandoc", args, { cwd: layout.sourceDir, scratchDir: layout.workDir, timeoutMs: PDF_EXPORT_TIMEOUT_MS });
  const pdf = await readFile(layout.outputFile);
  if (pdf.byteLength > MAX_PDF_OUTPUT_BYTES) {
    throw new PdfExportError(413, "PDF export is too large.");
  }
  return { pdf, filename: pdfFilename(sourceRel) };
}

function pdfExportLimiterConfig(): AsyncJobLimiterConfig {
  if (limiterConfigForTest) return limiterConfigForTest;
  return {
    concurrency: positiveIntEnv("COSHEAF_PDF_EXPORT_CONCURRENCY", DEFAULT_PDF_EXPORT_CONCURRENCY, { min: 1 }),
    queueLimit: positiveIntEnv("COSHEAF_PDF_EXPORT_QUEUE_LIMIT", DEFAULT_PDF_EXPORT_QUEUE_LIMIT),
    cooldownMs: positiveIntEnv("COSHEAF_PDF_EXPORT_COOLDOWN_MS", DEFAULT_PDF_EXPORT_COOLDOWN_MS),
  };
}

function positiveIntEnv(name: string, fallback: number, options: { min?: number } = {}): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  const min = options.min ?? 0;
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

async function checkPdfDependencies(cwd: string): Promise<void> {
  for (const tool of exportDependencyTools("pdf")) {
    try {
      await runCommand(tool.name, tool.version_args, { cwd, timeoutMs: DEPENDENCY_CHECK_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof PdfExportError) throw error;
      throw new PdfExportError(503, `PDF export requires ${tool.name}.`, tool.install_hint);
    }
  }
}

function resolveTemplatePath(
  template: string,
  options: { root: string; sourceDir: string; latexDir: string },
): string {
  if (LATEX_TEMPLATE_NAMES.has(template)) {
    return resolveLatexTemplatePath(template, {
      cwd: options.sourceDir,
      latexDir: options.latexDir,
    });
  }
  const rel = safeRel(template);
  if (!rel) {
    throw new PdfExportError(400, "Invalid PDF template path.");
  }
  const templatePath = path.resolve(options.sourceDir, rel);
  if (!isWithin(options.root, templatePath)) {
    throw new PdfExportError(400, "Invalid PDF template path.");
  }
  return templatePath;
}

function resolveCslPath(
  csl: string,
  options: { root: string; sourceDir: string; latexDir: string },
): string {
  if (LATEX_CSL_NAMES.has(csl)) {
    return resolveLatexCslPath(csl, {
      cwd: options.sourceDir,
      latexDir: options.latexDir,
    });
  }
  const rel = safeRel(csl);
  if (!rel) {
    throw new PdfExportError(400, "Invalid PDF citation style path.");
  }
  const cslPath = path.resolve(options.sourceDir, rel);
  if (!isWithin(options.root, cslPath)) {
    throw new PdfExportError(400, "Invalid PDF citation style path.");
  }
  return cslPath;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function materializeProject(root: string, files: readonly PdfProjectFile[]): Promise<void> {
  for (const file of files) {
    const rel = safeRel(file.path);
    if (!rel) continue;
    const target = path.join(root, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

async function runCommand(command: string, args: readonly string[], options: CommandOptions): Promise<void> {
  if (commandRunnerForTest) {
    await commandRunnerForTest(command, args, options);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: pdfExportCommandEnv(options.scratchDir ?? options.cwd),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killCommandProcessGroup(child);
    }, options.timeoutMs ?? PDF_EXPORT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutLength < 64_000) stdout.push(chunk);
      stdoutLength += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrLength < 64_000) stderr.push(chunk);
      stderrLength += chunk.length;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT") {
        reject(new PdfExportError(503, `PDF export requires ${command}.`));
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new PdfExportError(504, "PDF export timed out."));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim()
        || Buffer.concat(stdout).toString("utf8").trim()
        || `${command} exited with status ${code ?? "unknown"}`;
      reject(new PdfExportError(422, "PDF export failed.", detail));
    });
  });
}

function killCommandProcessGroup(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch (_error) {
      // Fall back to the immediate child if process-group signaling is not
      // available in this runtime.
    }
  }
  child.kill("SIGKILL");
}

function pdfExportCommandEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    HOME: cwd,
    LC_ALL: "C.UTF-8",
    PATH: process.env.PATH ?? "",
    TEXMFOUTPUT: cwd,
    TMPDIR: cwd,
    openin_any: "p",
    openout_any: "p",
  };
}

function pdfFilename(sourcePath: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath)) || "document";
  return `${base}.pdf`;
}
