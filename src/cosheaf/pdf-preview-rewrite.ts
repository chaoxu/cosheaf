// coflat renders a PDF figure (`![](fig.pdf)`) as <object type="application/pdf">,
// which collapses to an empty box without a browser PDF plugin and ignores the
// host's rasterized PNG. Swap each for an <img> pointing at the host's
// ?preview=png URL (a server-rendered PNG, see server/pdf-raster.ts) so figures
// display on every reader surface. coflat should ultimately emit the <img> itself
// (chaoxu/coflat#49); this host-side transform can drop out once it does.
export function rewritePdfPreviewObjects(root: HTMLElement): void {
  for (const obj of root.querySelectorAll<HTMLObjectElement>("object.cf-pdf-preview")) {
    const data = obj.getAttribute("data");
    if (!data) continue;
    const img = document.createElement("img");
    img.src = data;
    img.className = obj.getAttribute("class") ?? "cf-image";
    const alt = obj.getAttribute("aria-label");
    if (alt) img.alt = alt;
    obj.replaceWith(img);
  }
}
