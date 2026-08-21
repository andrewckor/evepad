// Parsing `git status --porcelain=v1 -b`. Pure on purpose: the route owns the
// spawn, this owns the meaning of the bytes.

export type GitStatus = {
  repo: true;
  branch: string | null;
  upstream: boolean;
  ahead: number;
  changed: number;
};

export function parseGitStatus(stdout: string): GitStatus {
  const lines = stdout.split("\n").filter(Boolean);
  const head = lines[0] ?? "";
  return {
    repo: true,
    branch: /^## ([^.\s]+)/.exec(head)?.[1] ?? null,
    upstream: head.includes("..."),
    ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
    changed: Math.max(lines.length - 1, 0),
  };
}
