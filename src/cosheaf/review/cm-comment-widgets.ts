// CodeMirror 6 extension: attach a React-rendered comment thread below each
// line that has comments. Rendered as a `Decoration.widget` so it slots into
// the editor's layout flow.

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { type EditorView, type DecorationSet, Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
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
    queueMicrotask(() => this.root?.unmount());
  }
}

export function commentThreadExtension(
  comments: readonly LineComment[],
  side: "new" | "old",
) {
  const byLine = groupCommentsByLine(comments);

  const decorate = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const bucket = byLine.get(`${side}:${i}`);
      if (!bucket) continue;
      const line = doc.line(i);
      builder.add(
        line.to,
        line.to,
        Decoration.widget({ widget: new ThreadWidget(bucket), block: true, side: 1 }),
      );
    }
    return builder.finish();
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
