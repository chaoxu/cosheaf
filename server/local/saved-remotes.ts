export interface SavedRemoteDisplay {
  url: string;
  label: string;
  username: string | null;
}

export function remoteHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch (_err) {
    return url;
  }
}

export function savedRemoteDisplayLabel(remote: SavedRemoteDisplay): string {
  return remote.username ? `${remote.label} (${remote.username})` : remote.label;
}

export function compareSavedRemotes(a: SavedRemoteDisplay, b: SavedRemoteDisplay): number {
  const host = remoteHostLabel(a.url).localeCompare(remoteHostLabel(b.url));
  if (host !== 0) return host;
  const label = a.label.localeCompare(b.label);
  return label !== 0 ? label : (a.username ?? "").localeCompare(b.username ?? "");
}
