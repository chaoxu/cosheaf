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

export interface WorkspaceValidation {
  broken_refs: BrokenReference[];
  orphan_labels: OrphanLabel[];
}
