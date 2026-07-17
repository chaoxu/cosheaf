import { Prec, StateEffect, StateField, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter, keymap, ViewPlugin } from "@codemirror/view";
import {
  suggestingHunkFingerprint,
  suggestingHunks,
  type SuggestingHunk,
} from "../../shared/suggesting-diff";
import { iconMarkup, lucideIcons } from "../../shared/lucide";

interface SuggestingModeOptions {
  baseText?: string | null;
  onAccept: (hunk: SuggestingHunk) => void;
  onRevert: (hunk: SuggestingHunk) => void;
  onCheckpoint: () => void;
}

export interface SuggestingModeController {
  extension: Extension;
  setBaseText: (baseText: string | null) => void;
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

const acceptHunkEffect = StateEffect.define<string>();
const setBaseTextEffect = StateEffect.define<string | null>();

function acceptedHunkKey(baseText: string, currentText: string, hunk: SuggestingHunk): string {
  return `${hunk.id}\0${suggestingHunkFingerprint(baseText, currentText, hunk)}`;
}

function hasBaseTextEffect(effects: readonly StateEffect<unknown>[]): boolean {
  return effects.some((effect) => effect.is(setBaseTextEffect));
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
    private readonly view: EditorView,
    private readonly opts: Pick<SuggestingModeOptions, "onAccept" | "onRevert"> & { baseText: () => string | null },
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
    button.setAttribute("aria-label", label);
    button.innerHTML = markup;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (label === "Accept hunk") {
        const baseText = this.opts.baseText();
        if (baseText === null) return;
        this.view.dispatch({
          effects: acceptHunkEffect.of(acceptedHunkKey(baseText, this.view.state.doc.toString(), this.hunk)),
        });
      }
      action();
    });
    return button;
  }
}

export function createSuggestingModeController(opts: SuggestingModeOptions): SuggestingModeController {
  let viewRef: EditorView | null = null;
  let currentBaseText = opts.baseText ?? null;
  const baseTextField = StateField.define<string | null>({
    create: () => currentBaseText,
    update: (value, transaction) => {
      for (const effect of transaction.effects) {
        if (effect.is(setBaseTextEffect)) return effect.value;
      }
      return value;
    },
  });
  const acceptedField = StateField.define<ReadonlySet<string>>({
    create: () => new Set<string>(),
    update: (value, transaction) => {
      if (hasBaseTextEffect(transaction.effects)) return new Set<string>();
      const next = new Set(value);
      for (const effect of transaction.effects) {
        if (effect.is(acceptHunkEffect)) next.add(effect.value);
      }
      return next;
    },
  });
  const hunkField = StateField.define<readonly SuggestingHunk[]>({
    create: (state) => currentBaseText === null ? [] : suggestingHunks(currentBaseText, state.doc.toString()),
    update: (value, transaction) => {
      if (!transaction.docChanged && !hasBaseTextEffect(transaction.effects)) return value;
      const baseText = transaction.state.field(baseTextField);
      return baseText === null ? [] : suggestingHunks(baseText, transaction.newDoc.toString());
    },
  });
  const visibleHunksForState = (state: EditorView["state"]): readonly SuggestingHunk[] => {
    const source = state.doc.toString();
    const baseText = state.field(baseTextField);
    if (baseText === null) return [];
    const accepted = state.field(acceptedField);
    return state.field(hunkField).filter((hunk) => !accepted.has(acceptedHunkKey(baseText, source, hunk)));
  };
  const visibleHunkField = StateField.define<readonly SuggestingHunk[]>({
    create: visibleHunksForState,
    update: (value, transaction) =>
      transaction.docChanged || hasBaseTextEffect(transaction.effects) || transaction.effects.some((effect) => effect.is(acceptHunkEffect))
        ? visibleHunksForState(transaction.state)
        : value,
  });
  const decorations = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state, state.field(visibleHunkField)),
    update: (value, transaction) =>
      transaction.docChanged || hasBaseTextEffect(transaction.effects) || transaction.effects.some((effect) => effect.is(acceptHunkEffect))
        ? buildDecorations(transaction.state, transaction.state.field(visibleHunkField))
        : value,
    provide: (field) => EditorView.decorations.from(field),
  });
  const accessibleGutter = ViewPlugin.define((view) => {
    viewRef = view;
    const expose = () => {
      const hasHunks = view.state.field(visibleHunkField).length > 0;
      view.dom.classList.toggle("cm-cosheaf-suggesting-has-hunks", hasHunks);
      view.dom.querySelector(".cm-gutters")?.setAttribute("aria-hidden", hasHunks ? "false" : "true");
    };
    expose();
    return {
      update: expose,
      destroy: () => {
        if (viewRef === view) viewRef = null;
      },
    };
  });
  const extension = [
    baseTextField,
    acceptedField,
    hunkField,
    visibleHunkField,
    decorations,
    accessibleGutter,
    gutter({
      class: "cm-cosheaf-suggesting-gutter",
      renderEmptyElements: true,
      initialSpacer: () => new SuggestingSpacerMarker(),
      lineMarker: (view, line) => {
        const lineNumber = view.state.doc.lineAt(line.from).number;
        const hunk = view.state.field(visibleHunkField).find((item) =>
          hunkAnchorLine(item, view.state.doc.lines) === lineNumber
        );
        return hunk ? new SuggestingHunkMarker(hunk, view, {
          onAccept: opts.onAccept,
          onRevert: opts.onRevert,
          baseText: () => view.state.field(baseTextField),
        }) : null;
      },
      lineMarkerChange: (update) => update.docChanged || update.transactions.some((tr) =>
        hasBaseTextEffect(tr.effects) || tr.effects.some((effect) => effect.is(acceptHunkEffect))
      ),
    }),
    Prec.highest(keymap.of([{
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        opts.onCheckpoint();
        return true;
      },
    }])),
    Prec.highest(EditorView.theme({
      "&.cm-cosheaf-suggesting-has-hunks .cm-gutters": {
        backgroundColor: "transparent",
        borderRight: "none",
        display: "flex",
      },
      "&.cm-cosheaf-suggesting-has-hunks .cm-gutter": {
        backgroundColor: "transparent",
      },
    })),
    EditorView.baseTheme({
      ".cm-cosheaf-suggesting-gutter": {
        backgroundColor: "transparent",
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
  return {
    extension,
    setBaseText: (baseText: string | null) => {
      currentBaseText = baseText;
      const view = viewRef;
      if (!view || view.state.field(baseTextField) === baseText) return;
      view.dispatch({ effects: setBaseTextEffect.of(baseText) });
    },
  };
}
