import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  resolve: {
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
      "@lezer/markdown",
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
      "@codemirror/lang-markdown",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/markdown",
    ],
    // The editor package is already a single bundled .mjs; Vite's optimizer
    // chokes on its `import("pdfjs-dist/.../pdf.worker.min.mjs?url")` line.
    exclude: ["@chaoxu/coflat-editor"],
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.COSHEAF_SERVER_URL ?? "http://localhost:3030",
        changeOrigin: true,
      },
    },
  },
});
