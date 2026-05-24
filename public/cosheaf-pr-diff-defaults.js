(() => {
  const url = new URL(window.location.href);
  if (url.searchParams.has("mode") || url.searchParams.has("shape")) return;
  const user = document.body.dataset.cosheafUser || "";
  const legacyModeKey = "cosheaf:diff-mode";
  const legacyShapeKey = "cosheaf:diff-shape";
  const modeKey = user ? `${legacyModeKey}:${user}` : legacyModeKey;
  const shapeKey = user ? `${legacyShapeKey}:${user}` : legacyShapeKey;
  const mode = (localStorage.getItem(modeKey) || localStorage.getItem(legacyModeKey)) === "source" ? "source" : "rich";
  const rawShape = localStorage.getItem(shapeKey) || localStorage.getItem(legacyShapeKey);
  const shapeValue = rawShape === "unified" || rawShape === "split" || rawShape === "after" ? rawShape : "after";
  const shape = mode === "rich" && shapeValue === "unified" ? "after" : shapeValue;
  url.searchParams.set("mode", mode);
  url.searchParams.set("shape", shape);
  window.location.replace(url);
})();
