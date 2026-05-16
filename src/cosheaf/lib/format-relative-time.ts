// "X{m,h,d} ago" formatter for timestamps that are usually < 1 week old
// (review comments, notification rows, approval entries). Returns "" for a
// falsy timestamp so empty rows render nothing.

export function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
