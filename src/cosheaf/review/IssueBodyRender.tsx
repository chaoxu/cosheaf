// Rich rendering for issue bodies and comments.
//
// TODO: switch to coflat-editor (Pandoc-flavored FORMAT.md) once coflat
// ships a "lite" read-only render mode. Tried mounting full coflat
// here in rich+readOnly; ran into:
//   1. Decoration overlays for cosheaf cross-refs (#N, path.md#L5-12)
//      conflict with coflat's own rich-mode widget replacements.
//   2. Per-instance editor cost — every comment thread mounting a CM6
//      surface is too heavy for the line-comment surface where N can be
//      large.
// Until coflat lite mode lands, use react-markdown with GitHub-flavored
// markdown + remark-math + rehype-katex. This is a *close* approximation
// of FORMAT.md (Pandoc-flavored): math, headings, lists, tables, code,
// blockquotes all render. Pandoc-specific features (footnotes, def lists,
// fenced divs) won't render but rarely matter in conversational issue
// bodies. The cosheaf cross-ref patterns ([@id], path.md#Lx, #N) are
// post-processed inside text nodes by `processChildren`.

import type { ReactElement, ReactNode } from "react";
import { Children, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

interface RenderProps {
  text: string;
  onOpenPageById?: (cosheafId: string) => void;
  onOpenPath?: (path: string, range: { from: number; to: number } | null, fragment: string | null) => void;
  onOpenNumber?: (n: number) => void;
}

const REF_RE =
  /\[@([a-z0-9][a-z0-9-]*)\]|(?:^|(?<=\s|\())([\w./-]+\.md(?:#L(\d+)(?:-(\d+))?|#[\w-]+)?)|(?:^|(?<=[\s(]))#(\d+)\b/g;

function tokenizeRefs(
  text: string,
  onOpenPageById?: (id: string) => void,
  onOpenPath?: (path: string, range: { from: number; to: number } | null, fragment: string | null) => void,
  onOpenNumber?: (n: number) => void,
): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text)) !== null) {
    if (m.index > cursor) nodes.push(text.slice(cursor, m.index));
    if (m[1]) {
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
    cursor = REF_RE.lastIndex;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.length === 0 ? text : <>{nodes}</>;
}

function processChildren(
  children: ReactNode,
  onOpenPageById?: (id: string) => void,
  onOpenPath?: (path: string, range: { from: number; to: number } | null, fragment: string | null) => void,
  onOpenNumber?: (n: number) => void,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return tokenizeRefs(child, onOpenPageById, onOpenPath, onOpenNumber);
    if (isValidElement(child)) return child;
    return child;
  });
}

export function IssueBodyRender({
  text,
  onOpenPageById,
  onOpenPath,
  onOpenNumber,
}: RenderProps): ReactElement {
  return (
    <div className="cf-issue-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ children }) => <p>{processChildren(children, onOpenPageById, onOpenPath, onOpenNumber)}</p>,
          li: ({ children }) => <li>{processChildren(children, onOpenPageById, onOpenPath, onOpenNumber)}</li>,
          td: ({ children }) => <td>{processChildren(children, onOpenPageById, onOpenPath, onOpenNumber)}</td>,
          h1: ({ children }) => <h1>{processChildren(children, onOpenPageById, onOpenPath, onOpenNumber)}</h1>,
          h2: ({ children }) => <h2>{processChildren(children, onOpenPageById, onOpenPath, onOpenNumber)}</h2>,
          h3: ({ children }) => <h3>{processChildren(children, onOpenPageById, onOpenPath, onOpenNumber)}</h3>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
