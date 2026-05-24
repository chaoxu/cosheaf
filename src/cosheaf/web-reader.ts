import { renderToHtml, hydrateMath, type DocumentContext } from "@chaoxu/coflat-editor/reader";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml";
import {
  REF_BUTTON_CLASS,
  sanitizeAndRewriteRefsFragment,
} from "./review/ref-rewriter";

interface ReaderPayload {
  source: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

function urlPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function resolveRepoLink(payload: ReaderPayload, href: string): string | null {
  const clean = href.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const baseDir = payload.path.includes("/") ? payload.path.slice(0, payload.path.lastIndexOf("/")) : "";
  const normalized = new URL(withoutHash, `https://cosheaf.invalid/${baseDir ? `${baseDir}/` : ""}`).pathname.slice(1);
  if (!normalized || normalized.split("/").includes("..")) return null;
  return `/${urlPath(payload.owner)}/${urlPath(payload.repo)}/src/branch/${urlPath(payload.branch)}/${urlPath(normalized)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

function documentContext(payload: ReaderPayload): DocumentContext {
  return {
    linkResolver: {
      resolve: (href) => {
        const resolved = resolveRepoLink(payload, href);
        return resolved ? { href: resolved } : null;
      },
    },
    refResolver: {
      resolve: (key) => ({
        content: `[@${key}]`,
        className: `${REF_BUTTON_CLASS} cosheaf-ref-page`,
      }),
    },
  };
}

function readPayload(root: HTMLElement): ReaderPayload | null {
  const script = root.querySelector<HTMLScriptElement>('script[type="application/json"]');
  if (!script?.textContent) return null;
  return JSON.parse(script.textContent) as ReaderPayload;
}

function renderIsland(root: HTMLElement): void {
  const payload = readPayload(root);
  if (!payload) return;
  const { body } = parseFrontmatterYaml(payload.source);
  const rendered = renderToHtml(body, documentContext(payload)).html;
  const fragment = sanitizeAndRewriteRefsFragment(rendered);
  rewriteRenderedRepoUrls(fragment, payload);
  root.replaceChildren(fragment);
  hydrateMath(root);
}

function rewriteRenderedRepoUrls(root: ParentNode, payload: ReaderPayload): void {
  for (const el of root.querySelectorAll<HTMLAnchorElement | HTMLImageElement>("a[href], img[src]")) {
    const attr = el instanceof HTMLImageElement ? "src" : "href";
    const value = el.getAttribute(attr);
    if (!value) continue;
    const resolved = resolveRepoLink(payload, value);
    if (resolved) el.setAttribute(attr, resolved);
  }
}

function installRefNavigation(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const ref = target?.closest<HTMLElement>(`.${REF_BUTTON_CLASS}`);
    if (!ref) return;
    const kind = ref.dataset.refKind;
    if (kind === "num" && ref.dataset.refNum) {
      event.preventDefault();
      const match = /^\/([^/]+)\/([^/]+)/.exec(window.location.pathname);
      if (match) window.location.href = `/${match[1]}/${match[2]}/issues/${encodeURIComponent(ref.dataset.refNum)}`;
    }
    if (kind === "path" && ref.dataset.refPath) {
      event.preventDefault();
      const match = /^\/([^/]+)\/([^/]+)/.exec(window.location.pathname);
      if (!match) return;
      const branch = document.querySelector<HTMLElement>("[data-reader-branch]")?.dataset.readerBranch ?? "main";
      const line = ref.dataset.refFrom ? `#L${ref.dataset.refFrom}${ref.dataset.refTo && ref.dataset.refTo !== ref.dataset.refFrom ? `-${ref.dataset.refTo}` : ""}` : "";
      window.location.href = `/${match[1]}/${match[2]}/src/branch/${urlPath(branch)}/${urlPath(ref.dataset.refPath)}${line}`;
    }
  });
}

for (const root of document.querySelectorAll<HTMLElement>(".coflat-reader-island")) {
  renderIsland(root);
}
installRefNavigation();
