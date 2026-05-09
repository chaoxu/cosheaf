import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CosheafApp } from "./app";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("missing #app");
createRoot(root).render(
  <StrictMode>
    <CosheafApp />
  </StrictMode>,
);
