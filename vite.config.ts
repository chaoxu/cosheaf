import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

const dotenvDev = path.resolve(__dirname, ".env.dev");
if (existsSync(dotenvDev)) process.loadEnvFile(dotenvDev);

export function viteHostForOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch (_err) {
    return undefined;
  }
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return undefined;
  return "0.0.0.0";
}

function viteHost(): string | undefined {
  return viteHostForOrigin(viteOrigin(process.env.COSHEAF_VITE_ORIGIN) ?? viteOriginFromWebUrl());
}

export function viteOriginFromWebUrl(webUrl = process.env.COSHEAF_WEB_URL, vitePort = process.env.COSHEAF_VITE_PORT ?? "5173"): string | undefined {
  const normalizedWebUrl = optionalEnv(webUrl);
  if (!normalizedWebUrl) return undefined;
  const normalizedVitePort = envPort(vitePort, "COSHEAF_VITE_PORT", "5173");
  try {
    const url = new URL(normalizedWebUrl);
    if (url.protocol !== "http:") return undefined;
    url.port = normalizedVitePort;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (_err) {
    return undefined;
  }
}

export function viteApiProxyTarget(serverUrl = process.env.COSHEAF_SERVER_URL, apiPort = process.env.COSHEAF_PORT): string {
  return optionalEnv(serverUrl) ?? `http://localhost:${envPort(apiPort, "COSHEAF_PORT", "3030")}`;
}

export function viteFsAllow(repoRoot = __dirname): string[] {
  const allow = new Set<string>([repoRoot]);
  const nodeModulesPath = path.resolve(repoRoot, "node_modules");
  if (existsSync(nodeModulesPath)) {
    try {
      allow.add(realpathSync(nodeModulesPath));
    } catch (_err) {
      allow.add(nodeModulesPath);
    }
  }
  return [...allow];
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function envPort(value: string | undefined, name: string, fallback: string): string {
  const port = optionalEnv(value) ?? fallback;
  if (!/^\d+$/.test(port) || Number(port) > 65535) {
    throw new Error(`${name} must be an integer TCP port`);
  }
  return port;
}

export function viteOrigin(value: string | undefined): string | undefined {
  const origin = optionalEnv(value);
  if (!origin) return undefined;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.origin;
  } catch (_err) {
    throw new Error("COSHEAF_VITE_ORIGIN must be a valid http(s) URL origin");
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
    // Force a single @codemirror/state instance across the page islands and
    // the editor package, otherwise `instanceof` checks across the boundary
    // fail and CM6 throws "Unrecognized extension value".
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@codemirror/autocomplete",
      "@codemirror/search",
      "@lezer/common",
      "@lezer/highlight",
    ],
  },
  build: {
    target: "es2022",
    sourcemap: process.env.COSHEAF_SOURCEMAP === "1",
    manifest: true,
    rollupOptions: {
      input: {
        "web-editor": path.resolve(__dirname, "src/cosheaf/web-editor.tsx"),
        "web-edit-shell": path.resolve(__dirname, "src/cosheaf/web-edit-shell.ts"),
        "web-comment-editor": path.resolve(__dirname, "src/cosheaf/web-comment-editor.tsx"),
        "web-reader": path.resolve(__dirname, "src/cosheaf/web-reader.ts"),
      },
    },
  },
  optimizeDeps: {
    include: [
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react",
      "react-dom",
      "react-dom/client",
      // CM6 / Lezer must be pre-bundled once so both the editor library and
      // the cosheaf shell see the *same* module instance (otherwise CM6's
      // `instanceof` checks fail across the boundary).
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@codemirror/autocomplete",
      "@codemirror/search",
      "@lezer/common",
      "@lezer/highlight",
      // PR-review surface deps — pre-bundle so the first visit to a PR
      // doesn't trigger a 5–15s optimize pause.
      "parse-diff",
      // hydrateMath dynamic-imports katex; pre-bundle so it's ready on first paint.
      "katex",
      // citation-js is CommonJS; pre-bundle so the reader's dynamic
      // `@chaoxu/coflat/citeproc` import gets working ESM named exports in dev
      // (otherwise: "does not provide an export named 'parse'").
      "@citation-js/core",
      "@citation-js/plugin-bibtex",
      "@citation-js/plugin-csl",
    ],
    // `@chaoxu/coflat` is a `file:` link. pnpm's content-addressed
    // folder name (`.pnpm/@chaoxu+coflat@file+..+coflat_<hash>/`)
    // changes whenever the editor source is touched, but optimizeDeps caches
    // pin the old hash → ENOENT → blank page. Excluding all entries means
    // Vite resolves them on the fly against the live tree. The editor is
    // already a single bundled .mjs so there's nothing to pre-bundle.
    exclude: [
      "@chaoxu/coflat",
      "@chaoxu/coflat/editor-lazy",
      "@chaoxu/coflat/inline-render",
      "@chaoxu/coflat/reader",
      "@chaoxu/coflat/rich-readonly",
      "@chaoxu/coflat/parse",
      "@chaoxu/coflat/citeproc",
    ],
  },
  server: {
    hmr: false,
    port: Number(envPort(process.env.COSHEAF_VITE_PORT, "COSHEAF_VITE_PORT", "5173")),
    host: viteHost(),
    fs: {
      allow: viteFsAllow(),
    },
    proxy: {
      "/api": {
        target: viteApiProxyTarget(),
        changeOrigin: true,
      },
    },
  },
});
