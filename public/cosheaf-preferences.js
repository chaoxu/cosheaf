(() => {
  const select = document.querySelector("[data-document-theme-user]");
  if (!(select instanceof HTMLSelectElement)) return;
  const legacyKey = "cosheaf:document-theme";
  const user = select.dataset.documentThemeUser || "";
  const key = user ? `${legacyKey}:${user}` : legacyKey;
  const normalize = (value) => value === "blueprint-book" ? value : "default";
  select.value = normalize(localStorage.getItem(key) || localStorage.getItem(legacyKey));
  select.addEventListener("change", () => {
    localStorage.setItem(key, select.value);
    localStorage.setItem(legacyKey, select.value);
  });
})();

(() => {
  const modeSelect = document.querySelector("[data-diff-mode-user]");
  const shapeSelect = document.querySelector("[data-diff-shape-user]");
  if (!(modeSelect instanceof HTMLSelectElement) || !(shapeSelect instanceof HTMLSelectElement)) return;
  const legacyModeKey = "cosheaf:diff-mode";
  const legacyShapeKey = "cosheaf:diff-shape";
  const user = modeSelect.dataset.diffModeUser || "";
  const modeKey = user ? `${legacyModeKey}:${user}` : legacyModeKey;
  const shapeKey = user ? `${legacyShapeKey}:${user}` : legacyShapeKey;
  const normalizeMode = (value) => value === "source" ? "source" : "rich";
  const normalizeShape = (value, mode) => {
    const shape = value === "unified" || value === "split" || value === "after" ? value : "after";
    return mode === "rich" && shape === "unified" ? "after" : shape;
  };
  const sync = () => {
    const mode = normalizeMode(modeSelect.value);
    const shape = normalizeShape(shapeSelect.value, mode);
    modeSelect.value = mode;
    shapeSelect.value = shape;
    shapeSelect.querySelector('option[value="unified"]').disabled = mode === "rich";
    localStorage.setItem(modeKey, mode);
    localStorage.setItem(shapeKey, shape);
    localStorage.setItem(legacyModeKey, mode);
    localStorage.setItem(legacyShapeKey, shape);
  };
  const initialMode = normalizeMode(localStorage.getItem(modeKey) || localStorage.getItem(legacyModeKey));
  modeSelect.value = initialMode;
  shapeSelect.value = normalizeShape(localStorage.getItem(shapeKey) || localStorage.getItem(legacyShapeKey), initialMode);
  sync();
  modeSelect.addEventListener("change", sync);
  shapeSelect.addEventListener("change", sync);
})();
