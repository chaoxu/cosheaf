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
      // PR-review surface deps — pre-bundle so the first visit to a PR
      // doesn't trigger a 5–15s optimize pause.
      "parse-diff",
      "react-diff-view",
      // Coflat reader/parse subpaths used outside the editor surface.
      "@chaoxu/coflat-editor/reader",
      "@chaoxu/coflat-editor/parse",
      // hydrateMath dynamic-imports katex; pre-bundle so it's ready on first paint.
      "katex",
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
