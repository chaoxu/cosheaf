import { coflatMarkdownFormat } from "./document-format/coflat.js";
import type { DocumentFormat } from "./document-format/types.js";

// Coflat is the only runtime document format. Route/API shapes still carry a
// historical `default_md_format` value, but server behavior is always Coflat.
export function getDocumentFormat(_id: string | null | undefined): DocumentFormat {
  return coflatMarkdownFormat;
}
