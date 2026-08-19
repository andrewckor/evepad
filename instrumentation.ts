// Runs once at server boot, and the server does not accept traffic until it
// resolves: a cold start finishes the one-time opencode download BEFORE
// "ready", a warm start pays one existsSync. Install failures don't block —
// Build retries and falls back on its own.
//
// The account profile and project list warm in the background (not awaited):
// both are WAN calls the first page load would otherwise pay, and by the
// time a browser opens they're already cached.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  import("@/lib/account").then(({ warmAccount }) => warmAccount()).catch(() => {});
  import("@/lib/projects")
    .then(({ listProjects }) => listProjects().catch(() => {}))
    .catch(() => {});
  const { warmOpencodeInstall } = await import("@/lib/opencode");
  await warmOpencodeInstall();
}
