export type VercelLink = {
  projectId: string | null;
  orgId: string | null;
};

// Unlinked checkouts are machine-local. Linked checkouts belong on the board
// only when both halves of their Vercel link are visible in the active scope.
export function localLinkVisible(
  link: VercelLink,
  projectIds: ReadonlySet<string>,
  orgIds: ReadonlySet<string>,
): boolean {
  if (!link.projectId && !link.orgId) return true;
  if (!link.projectId || !link.orgId) return false;
  return projectIds.has(link.projectId) && orgIds.has(link.orgId);
}

export function indexLinkedProjects<T>(
  items: Iterable<T>,
  projectId: (item: T) => string | null,
): Map<string, T> {
  const linked = new Map<string, T>();
  for (const item of items) {
    const id = projectId(item);
    if (id) linked.set(id, item);
  }
  return linked;
}
