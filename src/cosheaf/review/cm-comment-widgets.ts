// CodeMirror 6 extension: attach a React-rendered comment thread below each
// line that has comments. Block decorations must come from a StateField (not
// a ViewPlugin) per CM6's reconciler.

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { type EditorState, StateField } from "@codemirror/state";
import { type DecorationSet, Decoration, EditorView, WidgetType } from "@codemirror/view";
import { CommentThread } from "./CommentThread";
import { groupCommentsByLine } from "./comment-anchors";
import type { LineComment } from "../api";

class ThreadWidget extends WidgetType {
  private root: Root | null = null;
  constructor(private readonly comments: readonly LineComment[]) {
    super();
  }
  eq(other: ThreadWidget): boolean {
    return other.comments === this.comments;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cf-comment-host";
    this.root = createRoot(el);
    this.root.render(createElement(CommentThread, { comments: this.comments }));
    return el;
  }
  destroy(): void {
    // React 19 rejects synchronous unmount during render — defer to next tick.
    queueMicrotask(() => this.root?.unmount());
  }
}

export function commentThreadExtension(
  comments: readonly LineComment[],
  side: "new" | "old",
) {
  const byLine = groupCommentsByLine(comments);

  const build = (state: EditorState): DecorationSet => {
    const doc = state.doc;
    const ranges: { from: number; deco: Decoration }[] = [];
    for (let i = 1; i <= doc.lines; i++) {
      const bucket = byLine.get(`${side}:${i}`);
      if (!bucket) continue;
      const line = doc.line(i);
      ranges.push({
        from: line.to,
        deco: Decoration.widget({ widget: new ThreadWidget(bucket), block: true, side: 1 }),
      });
    }
    return Decoration.set(ranges.map((r) => r.deco.range(r.from)));
  };

  const field = StateField.define<DecorationSet>({
    create: build,
    update: (deco, tr) => (tr.docChanged ? deco.map(tr.changes) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field];
}
