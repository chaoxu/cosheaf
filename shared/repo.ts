// Repo-level DTOs shared by server and client for the settings surface.

// A repository collaborator and its resolved access role. `permission` is the
// Forgejo collaborator permission ("admin" | "write" | "read"), or null when it
// could not be read (e.g. the caller lacks rights to see another user's role).
export interface RepoCollaborator {
  login: string;
  permission: string | null;
}

export interface RepoCollaborators {
  collaborators: RepoCollaborator[];
}

export interface RepoTopics {
  topics: string[];
}
