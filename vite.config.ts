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
    manifest: true,
    rollupOptions: {
      input: {
        app: path.resolve(__dirname, "index.html"),
        "web-editor": path.resolve(__dirname, "src/cosheaf/web-editor.tsx"),
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
    ],
    // `@chaoxu/coflat-editor` is a `file:` link. pnpm's content-addressed
    // folder name (`.pnpm/@chaoxu+coflat-editor@file+..+coflat-editor_<hash>/`)
    // changes whenever the editor source is touched, but optimizeDeps caches
    // pin the old hash → ENOENT → blank page. Excluding all entries means
    // Vite resolves them on the fly against the live tree. The editor is
    // already a single bundled .mjs so there's nothing to pre-bundle.
    exclude: [
      "@chaoxu/coflat-editor",
      "@chaoxu/coflat-editor/reader",
      "@chaoxu/coflat-editor/parse",
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
