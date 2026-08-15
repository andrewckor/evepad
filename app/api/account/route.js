// Who the cockpit is logged in as, straight from the Vercel CLI's own
// credentials — the same token and currentTeam that pick which projects show
// up. Read-only: switching accounts or teams is `vercel login` / `vercel
// switch`, and mirroring those here would just be a second source of truth.

import { cliToken, currentTeam } from "../../../lib/projects.js";

export const dynamic = "force-dynamic";

// Vercel's public avatar service — the dashboard's own, so it needs no auth
// and gives us the same picture the user sees there.
const avatarUrl = (id) => (id ? `https://vercel.com/api/www/avatar/${id}?s=64` : null);

// One identity lookup is cheap, but this sits behind a header that renders on
// every page — cache it long enough that navigation never waits on it.
let cache = { at: 0, key: null, data: null };
const TTL = 60_000;

async function api(path, token) {
  const r = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

export async function GET() {
  const token = cliToken();
  const team = currentTeam();
  if (!token) {
    return Response.json({
      loggedIn: false,
      hint: "Run `vercel login` (or set VERCEL_TOKEN) to see your Vercel agents.",
    });
  }

  const key = token.slice(0, 12) + ":" + (team ?? "");
  if (cache.key === key && Date.now() - cache.at < TTL) return Response.json(cache.data);

  try {
    const [me, teamList] = await Promise.all([
      api("/v2/user", token),
      api("/v2/teams?limit=50", token).catch(() => ({ teams: [] })),
    ]);
    const u = me.user ?? me;
    const teams = (teamList.teams ?? []).map((t) => ({
      id: t.id, slug: t.slug, name: t.name ?? t.slug, avatarUrl: avatarUrl(t.avatar),
    }));
    // currentTeam is stored as either a team id or a slug, depending on how
    // the CLI last set it — match on both rather than guessing.
    let active = team ? teams.find((t) => t.id === team || t.slug === team) ?? null : null;

    // With no currentTeam set, the CLI is NOT necessarily on the personal
    // account: this token returns team-owned projects by default (every
    // project here carries accountId team_...). Labelling that "personal"
    // would name a scope the listing doesn't come from, so ask what the token
    // actually resolves to and match it against the team list.
    if (!active) {
      const probe = await api("/v10/projects?limit=1", token).catch(() => null);
      const owner = probe?.projects?.[0]?.accountId;
      if (owner?.startsWith("team_")) active = teams.find((t) => t.id === owner) ?? null;
    }

    const data = {
      loggedIn: true,
      tokenSource: process.env.VERCEL_TOKEN ? "VERCEL_TOKEN" : "vercel CLI",
      user: {
        username: u.username, name: u.name ?? u.username, email: u.email,
        avatarUrl: avatarUrl(u.avatar),
      },
      // With no currentTeam the CLI is on the personal account — say so
      // explicitly rather than leaving the scope blank.
      scope: active ?? { id: null, slug: u.username, name: u.name ?? u.username, avatarUrl: avatarUrl(u.avatar), personal: true },
      teams,
    };
    cache = { at: Date.now(), key, data };
    return Response.json(data);
  } catch (e) {
    return Response.json({ loggedIn: false, error: String(e.message ?? e).slice(0, 200) });
  }
}
