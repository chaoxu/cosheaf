// Workspace-scoped context: slug + active markdown format + the
// link/title lookup ("documentContext") needed by Coflat renderers.
//
// Before this file, ApprovalsPanel/DiffArea/IssueView/PrHeader all took
// these as three separate props that WorkspaceView drilled through every
// render path. The values change rarely (slug never; formatId on settings
// save; documentContext when the file tree changes), so context is the
// right shape.
//
// SettingsPanel is intentionally NOT a consumer here: it edits the format
// (initialFormatId + onFormatChanged) rather than just reading it.

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { DocumentFormatId } from "../../shared/document-format";
import type { DocumentContext } from "./document-format/coflat-context";

export interface WorkspaceContextValue {
  slug: string;
  formatId: DocumentFormatId;
  documentContext?: DocumentContext;
}

const WorkspaceCtx = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceContextValue;
  children: ReactNode;
}) {
  return <WorkspaceCtx.Provider value={value}>{children}</WorkspaceCtx.Provider>;
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const v = useContext(WorkspaceCtx);
  if (!v) throw new Error("useWorkspaceContext must be used inside <WorkspaceProvider>");
  return v;
}
