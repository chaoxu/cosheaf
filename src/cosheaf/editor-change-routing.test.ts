import { describe, expect, it, vi } from "vitest";
import { COFLAT_FORMAT_ID, FORGEJO_PASSTHROUGH_FORMAT_ID } from "../../shared/document-format";
import { liveEditorSource, routeEditorChangeHandlers } from "./editor-change-routing";

describe("routeEditorChangeHandlers", () => {
  it("uses metadata-only document changes for Coflat", () => {
    const onStringChange = vi.fn();
    const onDocumentChange = vi.fn();
    const routed = routeEditorChangeHandlers(COFLAT_FORMAT_ID, { onStringChange, onDocumentChange });

    expect(routed.onChange).toBeUndefined();
    expect(routed.onDocumentChange).toBe(onDocumentChange);
  });

  it("uses direct string changes for Forgejo passthrough", () => {
    const onStringChange = vi.fn();
    const onDocumentChange = vi.fn();
    const routed = routeEditorChangeHandlers(FORGEJO_PASSTHROUGH_FORMAT_ID, { onStringChange, onDocumentChange });

    expect(routed.onChange).toBe(onStringChange);
    expect(routed.onDocumentChange).toBeUndefined();
  });
});

describe("liveEditorSource", () => {
  it("reads from the mounted editor when available", () => {
    expect(liveEditorSource({ getDoc: () => "live" }, "stale")).toBe("live");
  });

  it("falls back before the editor has mounted", () => {
    expect(liveEditorSource(null, "fallback")).toBe("fallback");
  });
});
