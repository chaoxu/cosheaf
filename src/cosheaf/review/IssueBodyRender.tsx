// Rich-markdown rendering for issue bodies and comments. Uses
// react-markdown with remark-gfm + remark-math + rehype-katex so headings,
// lists, tables, inline code, code fences, $math$, and $$display math$$
// all render. Plain-text segments are then post-processed for cosheaf's
// three cross-link patterns:
//   [@page-id]                  → workspace cross-reference
//   path/to.md(#L1-2 | #frag)?  → page link, optionally with line range
//   #N                          → issue or PR cross-reference

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
  return nodes.length === 1 && typeof nodes[0] === "string" ? text : <>{nodes}</>;
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
    <div className="cf-issue-body prose prose-sm max-w-none">
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
