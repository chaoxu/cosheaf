// CodeMirror 6 extension: tint specific lines with a CSS class.
// The line numbers are 1-based and refer to absolute lines in the editor doc.

import { Decoration, EditorView, type DecorationSet, ViewPlugin } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

export function lineTintExtension(addedLines: readonly number[]) {
  const set = new Set(addedLines);

  const decorate = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      if (!set.has(i)) continue;
      const line = doc.line(i);
      builder.add(line.from, line.from, Decoration.line({ class: "cf-diff-added" }));
    }
    return builder.finish();
  };

  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = decorate(view);
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.baseTheme({
      ".cf-diff-added": {
        backgroundColor: "rgba(34, 197, 94, 0.12)",
      },
      ".cf-diff-removed": {
        backgroundColor: "rgba(239, 68, 68, 0.12)",
      },
    }),
  ];
}
