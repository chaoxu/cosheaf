// Lightweight renderer for issue bodies and comments. Plain text passes
// through; we only special-case the two math-native links cosheaf cares
// about:
//   [@page-id]                  → cross-reference into the workspace
//   relative/path.md            → file link
//   relative/path.md#L5-12      → file link scrolled to a line range
//   relative/path.md#fragment   → file link with anchor

import type { ReactElement } from "react";

interface RenderProps {
  text: string;
  onOpenPageById?: (cosheafId: string) => void;
  onOpenPath?: (path: string, range: { from: number; to: number } | null, fragment: string | null) => void;
  onOpenNumber?: (n: number) => void;
}

// Crude tokenizer: walks the string, emitting plaintext + ref nodes. Avoids
// pulling in a full markdown engine for what's effectively a few patterns.
//   [@page-id]
//   path/to.md(#L1-2 | #fragment)?
//   #N        — cross-reference to an issue or PR
export function IssueBodyRender({ text, onOpenPageById, onOpenPath, onOpenNumber }: RenderProps): ReactElement {
  const nodes: ReactElement[] = [];
  let cursor = 0;
  const re = /\[@([a-z0-9][a-z0-9-]*)\]|(?:^|(?<=\s|\())([\w./-]+\.md(?:#L(\d+)(?:-(\d+))?|#[\w-]+)?)|(?:^|(?<=[\s(]))#(\d+)\b/g;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) {
      nodes.push(<span key={key++}>{text.slice(cursor, m.index)}</span>);
    }
    if (m[1]) {
      // [@page-id]
      const id = m[1];
      nodes.push(
        <button
          key={key++}
          type="button"
          onClick={() => onOpenPageById?.(id)}
          className="text-[var(--cf-accent)] hover:underline"
          data-testid={`ref-page-${id}`}
        >
          [@{id}]
        </button>,
      );
    } else if (m[5]) {
      // #N
      const n = Number(m[5]);
      nodes.push(
        <button
          key={key++}
          type="button"
          onClick={() => onOpenNumber?.(n)}
          className="text-[var(--cf-accent)] hover:underline"
          data-testid={`ref-num-${n}`}
        >
          #{n}
        </button>,
      );
    } else if (m[2]) {
      const link = m[2];
      const hashIdx = link.indexOf("#");
      const path = hashIdx >= 0 ? link.slice(0, hashIdx) : link;
      const frag = hashIdx >= 0 ? link.slice(hashIdx + 1) : null;
      let range: { from: number; to: number } | null = null;
      let fragment: string | null = null;
      if (frag) {
        const lm = /^L(\d+)(?:-(\d+))?$/.exec(frag);
        if (lm) {
          const from = Number(lm[1]);
          const to = lm[2] ? Number(lm[2]) : from;
          range = { from, to };
        } else {
          fragment = frag;
        }
      }
      nodes.push(
        <button
          key={key++}
          type="button"
          onClick={() => onOpenPath?.(path, range, fragment)}
          className="text-[var(--cf-accent)] hover:underline"
          data-testid={`ref-path-${path}`}
        >
          {link}
        </button>,
      );
    }
    cursor = re.lastIndex;
  }
  if (cursor < text.length) nodes.push(<span key={key++}>{text.slice(cursor)}</span>);
  return <div className="whitespace-pre-wrap break-words">{nodes}</div>;
}
