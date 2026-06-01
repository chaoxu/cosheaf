export interface BrokenReference {
  source_id: string;
  source_path: string;
  source_title: string | null;
  target_id: string | null;
  target_label: string;
  line: number | null;
}

export interface OrphanLabel {
  id: string;
  path: string;
  title: string | null;
}

export interface DuplicateXref {
  id: string;
  paths: string;
  count: number;
}

export interface WorkspaceValidation {
  broken_refs: BrokenReference[];
  duplicate_xrefs: DuplicateXref[];
  orphan_labels: OrphanLabel[];
}
