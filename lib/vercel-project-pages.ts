type VercelProjectsPage<T> = {
  projects?: T[];
  pagination?: { next?: string | number | null };
};

export async function collectVercelProjectPages<T>(
  loadPage: (until: string | null) => Promise<VercelProjectsPage<T>>,
): Promise<T[]> {
  const projects: T[] = [];
  const seenCursors = new Set<string>();
  let until: string | null = null;

  for (;;) {
    const page = await loadPage(until);
    projects.push(...(page.projects ?? []));
    const next = page.pagination?.next;
    if (next === null || next === undefined) return projects;

    const cursor = String(next);
    if (seenCursors.has(cursor)) throw new Error("projects API returned a repeated cursor");
    seenCursors.add(cursor);
    until = cursor;
  }
}
