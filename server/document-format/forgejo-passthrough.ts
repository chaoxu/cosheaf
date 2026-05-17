import {
  extractFirstH1,
  parseFrontmatterYaml,
  serializeFrontmatterYaml,
} from "../../shared/frontmatter-yaml.js";
import { FORGEJO_PASSTHROUGH_FORMAT_ID } from "../../shared/document-format.js";
import type { DocumentFormat } from "./types.js";

export const forgejoPassthroughFormat: DocumentFormat = {
  id: FORGEJO_PASSTHROUGH_FORMAT_ID,
  displayName: "Forgejo Markdown",
  extensions: [".md"],
  parseDocument: parseFrontmatterYaml,
  serializeDocument: serializeFrontmatterYaml,
  extractTitle: extractFirstH1,
  extractLinks: () => [],
};
