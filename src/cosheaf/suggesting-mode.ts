import { Prec, StateField, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter, keymap } from "@codemirror/view";
import {
  suggestingHunks,
  type SuggestingHunk,
} from "../../shared/suggesting-diff";
import { iconMarkup, lucideIcons } from "../../shared/lucide";

interface SuggestingModeOptions {
  baseText: string;
  onAccept: (hunk: SuggestingHunk) => void;
  onRevert: (hunk: SuggestingHunk) => void;
  onCheckpoint: () => void;
}

function hunkAnchorLine(hunk: SuggestingHunk, docLines: number): number {
  return Math.max(1, Math.min(docLines, hunk.new_start));
}

function lineRangeForHunk(state: EditorView["state"], hunk: SuggestingHunk): { from: number; to: number; lineFrom: number } {
  const lineFrom = hunkAnchorLine(hunk, state.doc.lines);
  if (hunk.new_lines === 0) {
    const line = state.doc.line(lineFrom);
    return { from: line.from, to: line.from, lineFrom };
  }
  const lineTo = Math.max(lineFrom, Math.min(state.doc.lines, lineFrom + hunk.new_lines - 1));
  const from = state.doc.line(lineFrom).from;
  const to = state.doc.line(lineTo).to;
  return { from, to, lineFrom };
}

function buildDecorations(state: EditorView["state"], hunks: readonly SuggestingHunk[]): DecorationSet {
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (const hunk of hunks) {
    const range = lineRangeForHunk(state, hunk);
    const lineClass = hunk.kind === "delete"
      ? "cm-cosheaf-suggesting-line cm-cosheaf-suggesting-line-delete"
      : "cm-cosheaf-suggesting-line";
    ranges.push({
      from: range.from,
      to: range.from,
      decoration: Decoration.line({ class: lineClass }),
    });
    if (range.to > range.from) {
      ranges.push({
        from: range.from,
        to: range.to,
        decoration: Decoration.mark({ class: `cm-cosheaf-suggesting-${hunk.kind}` }),
      });
    }
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.decoration);
  return builder.finish();
}

class SuggestingSpacerMarker extends GutterMarker {
  toDOM(): Node {
    const span = document.createElement("span");
    span.className = "cm-cosheaf-suggesting-spacer";
    span.textContent = " ";
    return span;
  }
}

class SuggestingHunkMarker extends GutterMarker {
  constructor(
    private readonly hunk: SuggestingHunk,
    private readonly opts: SuggestingModeOptions,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof SuggestingHunkMarker && other.hunk.id === this.hunk.id;
  }

  toDOM(): Node {
    const wrap = document.createElement("span");
    wrap.className = "cm-cosheaf-suggesting-actions";
    wrap.append(
      this.button("Accept hunk", iconMarkup(lucideIcons.check, { size: 12 }), () => this.opts.onAccept(this.hunk)),
      this.button("Revert hunk", iconMarkup(lucideIcons.x, { size: 12 }), () => this.opts.onRevert(this.hunk)),
    );
    return wrap;
  }

  private button(label: string, markup: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.ariaLabel = label;
    button.innerHTML = markup;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return button;
  }
}

export function suggestingModeExtension(opts: SuggestingModeOptions): Extension {
  const hunkField = StateField.define<readonly SuggestingHunk[]>({
    create: (state) => suggestingHunks(opts.baseText, state.doc.toString()),
    update: (value, transaction) =>
      transaction.docChanged ? suggestingHunks(opts.baseText, transaction.newDoc.toString()) : value,
  });
  const decorations = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state, state.field(hunkField)),
    update: (value, transaction) =>
      transaction.docChanged ? buildDecorations(transaction.state, transaction.state.field(hunkField)) : value,
    provide: (field) => EditorView.decorations.from(field),
  });
  return [
    hunkField,
    decorations,
    gutter({
      class: "cm-cosheaf-suggesting-gutter",
      renderEmptyElements: true,
      initialSpacer: () => new SuggestingSpacerMarker(),
      lineMarker: (view, line) => {
        const lineNumber = view.state.doc.lineAt(line.from).number;
        const hunk = view.state.field(hunkField).find((item) =>
          hunkAnchorLine(item, view.state.doc.lines) === lineNumber
        );
        return hunk ? new SuggestingHunkMarker(hunk, opts) : null;
      },
      lineMarkerChange: (update) => update.docChanged,
    }),
    Prec.highest(keymap.of([{
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        opts.onCheckpoint();
        return true;
      },
    }])),
    EditorView.baseTheme({
      ".cm-cosheaf-suggesting-gutter": {
        minWidth: "42px",
      },
      ".cm-cosheaf-suggesting-actions": {
        display: "inline-flex",
        alignItems: "center",
        gap: "2px",
      },
      ".cm-cosheaf-suggesting-actions button": {
        width: "17px",
        height: "17px",
        padding: "0",
        border: "1px solid var(--cf-border, #d4d4d8)",
        borderRadius: "3px",
        background: "var(--cf-bg, white)",
        color: "var(--cf-muted, #71717a)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
      },
      ".cm-cosheaf-suggesting-actions button:hover": {
        color: "var(--cf-fg, #18181b)",
        borderColor: "var(--cf-border-strong, #a1a1aa)",
      },
      ".cm-cosheaf-suggesting-insert": {
        backgroundColor: "rgb(34 197 94 / .16)",
      },
      ".cm-cosheaf-suggesting-change": {
        backgroundColor: "rgb(234 179 8 / .18)",
      },
      ".cm-cosheaf-suggesting-line": {
        backgroundImage: "linear-gradient(90deg, rgb(34 197 94 / .55) 0 3px, transparent 3px)",
      },
      ".cm-cosheaf-suggesting-line-delete": {
        backgroundColor: "rgb(239 68 68 / .10)",
        backgroundImage: "linear-gradient(90deg, rgb(239 68 68 / .55) 0 3px, transparent 3px)",
      },
    }),
  ];
}
