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
  parseLatexFrontmatterConfig,
  preprocessWithReadFile,
  resolveLatexCslPath,
  resolveLatexExportOptions,
  resolveLatexTemplatePath,
} from "@chaoxu/coflat/latex";
import { safeRel } from "./routes/files.js";

export interface PdfProjectFile {
  readonly path: string;
  readonly content: Buffer;
}

export interface PdfExportResult {
  readonly pdf: Buffer;
  readonly filename: string;
}

interface ExportCoflatPdfOptions {
  readonly source: string;
  readonly sourcePath: string;
  readonly files: readonly PdfProjectFile[];
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

interface CommandOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<void>;

let commandRunnerForTest: CommandRunner | null = null;

const DEPENDENCY_CHECK_TIMEOUT_MS = 10_000;
const PDF_EXPORT_TIMEOUT_MS = 120_000;
const MAX_PDF_OUTPUT_BYTES = 100 * 1024 * 1024;

export function _setPdfExportCommandRunnerForTest(runner: CommandRunner | null): void {
  commandRunnerForTest = runner;
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
  const sourceRel = safeRel(options.sourcePath);
  if (!sourceRel) {
    throw new PdfExportError(400, "Invalid document path.");
  }

  const root = await mkdtemp(path.join(tmpdir(), "cosheaf-pdf-"));
  try {
    await checkPdfDependencies(root);
    await materializeProject(root, options.files);

    const sourceFile = path.join(root, sourceRel);
    const preprocessed = await preprocessWithReadFile(options.source);
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, preprocessed, "utf8");

    const outputFile = path.join(root, `${path.basename(sourceRel, path.extname(sourceRel))}.pdf`);
    const sourceDir = path.dirname(sourceFile);
    const latexDir = path.dirname(fileURLToPath(import.meta.resolve("@chaoxu/coflat/latex/filter.lua")));
    const config = latexConfigWithDefaults(parseLatexFrontmatterConfig(options.source), options.defaults);
    const exportOptions = resolveLatexExportOptions({ config, flags: options.flags ?? {} });
    const template = resolveTemplatePath(exportOptions.template, {
      latexDir,
      root,
      sourceDir,
    });
    const csl = resolveCslPath(exportOptions.csl, {
      latexDir,
      root,
      sourceDir,
    });
    const args = [
      ...buildLatexPandocArgs({
        bibliography: exportOptions.bibliography,
        cslPath: csl,
        filterPath: path.join(latexDir, "filter.lua"),
        format: "pdf",
        output: outputFile,
        resourcePath: buildPandocResourcePath(root, sourceDir),
        template,
      }),
      sourceFile,
    ];

    await runCommand("pandoc", args, { cwd: sourceDir, timeoutMs: PDF_EXPORT_TIMEOUT_MS });
    const pdf = await readFile(outputFile);
    if (pdf.byteLength > MAX_PDF_OUTPUT_BYTES) {
      throw new PdfExportError(413, "PDF export is too large.");
    }
    return { pdf, filename: pdfFilename(sourceRel) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface LatexConfig {
  bibliography?: string;
  csl?: string;
  latex?: {
    bibliography?: string;
    csl?: string;
    template?: string;
  };
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function latexConfigWithDefaults(config: LatexConfig, defaults: ExportCoflatPdfOptions["defaults"]): LatexConfig {
  if (!defaults) return config;
  const latex = config.latex ?? {};
  return {
    ...config,
    bibliography: stringOption(latex.bibliography) || stringOption(config.bibliography)
      ? config.bibliography
      : defaults.bibliography,
    csl: stringOption(latex.csl) || stringOption(config.csl)
      ? config.csl
      : defaults.csl,
    latex: {
      ...latex,
      ...(!stringOption(latex.template) && defaults.template ? { template: defaults.template } : {}),
    },
  };
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
      env: pdfExportCommandEnv(options.cwd),
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
