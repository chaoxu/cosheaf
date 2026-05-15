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
    // Force a single @codemirror/state instance across the editor bundle and
    // the cosheaf shell — otherwise `instanceof` checks across the boundary
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
    sourcemap: true,
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
      // Citation-js packages are CJS; coflat-editor 0.1.13's bundled .mjs does
      // named imports (`import { parse } from '@citation-js/name'`) which fail
      // unless Vite pre-bundles them into ESM.
      "@citation-js/core",
      "@citation-js/name",
      "@citation-js/date",
      "@citation-js/plugin-bibtex",
      "@citation-js/plugin-csl",
      // PR-review surface deps — pre-bundle so the first visit to a PR
      // doesn't trigger a 5–15s optimize pause.
      "parse-diff",
      "react-diff-view",
      "react-markdown",
      "remark-gfm",
      "remark-math",
      "rehype-katex",
    ],
    // The editor package is already a single bundled .mjs; Vite's optimizer
    // chokes on its `import("pdfjs-dist/.../pdf.worker.min.mjs?url")` line.
    exclude: ["@chaoxu/coflat-editor"],
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
