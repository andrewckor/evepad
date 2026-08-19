// Runs once at server boot, and the server does not accept traffic until it
// resolves: a cold start finishes the one-time opencode download BEFORE
// "ready", a warm start pays one existsSync. Install failures don't block —
// Build retries and falls back on its own.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { warmOpencodeInstall } = await import("@/lib/opencode");
  await warmOpencodeInstall();
}
