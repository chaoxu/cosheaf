import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

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
      "react-diff-view",
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
      "@chaoxu/coflat/reader",
      "@chaoxu/coflat/parse",
      "@chaoxu/coflat/citeproc",
    ],
  },
  server: {
    hmr: false,
    proxy: {
      "/api": {
        target: process.env.COSHEAF_SERVER_URL ?? "http://localhost:3030",
        changeOrigin: true,
      },
    },
  },
});
