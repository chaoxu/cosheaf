import { describe, expect, it, vi } from "vitest";
import { ChangeSet } from "@codemirror/state";
import { COFLAT_FORMAT_ID } from "../../shared/document-format";
import {
  applyDocumentChangeText,
  IncrementalSourceCache,
  liveEditorSource,
  routeEditorChangeHandlers,
  textFromSource,
} from "./editor-change-routing";

describe("routeEditorChangeHandlers", () => {
  it("uses metadata-only document changes for Coflat", () => {
    const onStringChange = vi.fn();
    const onDocumentChange = vi.fn();
    const routed = routeEditorChangeHandlers(COFLAT_FORMAT_ID, { onStringChange, onDocumentChange });

    expect(routed.onChange).toBeUndefined();
    expect(routed.onDocumentChange).toBe(onDocumentChange);
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

describe("incremental source text helpers", () => {
  it("round-trips source strings through CodeMirror Text", () => {
    expect(textFromSource("a\nb\n").toString()).toBe("a\nb\n");
  });

  it("applies Coflat document change metadata without reading the mounted editor", () => {
    const before = textFromSource("alpha\nbeta");
    const changes = ChangeSet.of({ from: 6, to: 10, insert: "gamma" }, before.length);

    expect(applyDocumentChangeText(before, { changes }).toString()).toBe("alpha\ngamma");
  });

  it("tracks versions for stale async work suppression", () => {
    const cache = new IncrementalSourceCache("alpha");
    const startedAt = cache.version();
    const changes = ChangeSet.of({ from: 5, to: 5, insert: " beta" }, cache.source().length);

    cache.apply({ changes });

    expect(cache.source()).toBe("alpha beta");
    expect(cache.isCurrent(startedAt)).toBe(false);
    expect(cache.isCurrent(cache.version())).toBe(true);
  });

  it("resets the cached source for programmatic editor updates", () => {
    const cache = new IncrementalSourceCache("alpha");
    const changes = ChangeSet.of({ from: 5, to: 5, insert: " beta" }, cache.source().length);
    cache.apply({ changes });

    cache.reset("fresh");

    expect(cache.source()).toBe("fresh");
  });
});
