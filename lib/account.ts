// Who the cockpit is logged in as, straight from the Vercel CLI's own
// credentials — the same token and currentTeam that pick which projects show
// up. Read-only: switching accounts or teams is `vercel login` / `vercel
// switch`, and mirroring those here would just be a second source of truth.
//
// The split that keeps first paint instant: SIGNED-IN is a local fact (the
// CLI token exists on disk), the PROFILE is remote decoration. The profile is
// cached in memory and persisted to ~/.evepad, so every load after the very
// first serves it instantly and refreshes behind; a failed refresh degrades
// the profile, never the signed-in verdict — flashing `vercel login` at a
// logged-in user is the one unacceptable outcome.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { cliToken, currentTeam } from "./projects";
import { errMsg } from "./utils";
import type { Account, AccountScope } from "./types";

// Vercel's public avatar service — the dashboard's own, so it needs no auth
// and gives us the same picture the user sees there.
const avatarUrl = (id: string | null | undefined) =>
  id ? `https://vercel.com/api/www/avatar/${id}?s=64` : null;

const TTL = 60_000;
const diskPath = () => join(homedir(), ".evepad", "account.json");

type Cached = { at: number; key: string; data: Account };
let mem: Cached | null = null;
let refreshing: Promise<Account> | null = null;

function readDisk(): Cached | null {
  try {
    const c = JSON.parse(readFileSync(diskPath(), "utf8")) as Cached;
    return c && c.key && c.data ? c : null;
  } catch {
    return null;
  }
}
function writeDisk(c: Cached): void {
  try {
    mkdirSync(join(homedir(), ".evepad"), { recursive: true });
    writeFileSync(diskPath(), JSON.stringify(c));
  } catch {}
}

type VercelTeam = { id: string; slug: string; name?: string; avatar?: string };

async function api(path: string, token: string): Promise<any> {
  const r = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

const tokenSource = () => (process.env.VERCEL_TOKEN ? "VERCEL_TOKEN" : "vercel CLI");

async function fetchProfile(token: string, team: string | null): Promise<Account> {
  const [me, teamList] = await Promise.all([
    api("/v2/user", token),
    api("/v2/teams?limit=50", token).catch(() => ({ teams: [] })),
  ]);
  const u = me.user ?? me;
  const teams: AccountScope[] = ((teamList.teams ?? []) as VercelTeam[]).map((t) => ({
    id: t.id,
    slug: t.slug,
    name: t.name ?? t.slug,
    avatarUrl: avatarUrl(t.avatar),
  }));
  // currentTeam is stored as either a team id or a slug, depending on how
  // the CLI last set it — match on both rather than guessing.
  let active = team ? (teams.find((t) => t.id === team || t.slug === team) ?? null) : null;

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

  return {
    loggedIn: true,
    tokenSource: tokenSource(),
    user: {
      username: u.username,
      name: u.name ?? u.username,
      email: u.email,
      avatarUrl: avatarUrl(u.avatar),
    },
    // With no currentTeam the CLI is on the personal account — say so
    // explicitly rather than leaving the scope blank.
    scope: active ?? {
      id: null,
      slug: u.username,
      name: u.name ?? u.username,
      avatarUrl: avatarUrl(u.avatar),
      personal: true,
    },
    teams,
  };
}

export async function getAccount(): Promise<Account> {
  const token = cliToken();
  if (!token)
    return {
      loggedIn: false,
      hint: "Run `vercel login` (or set VERCEL_TOKEN) to see your Vercel agents.",
    };

  const team = currentTeam();
  const key = token.slice(0, 12) + ":" + (team ?? "");

  if (mem?.key === key && Date.now() - mem.at < TTL) return mem.data;

  const kick = () => {
    refreshing ??= fetchProfile(token, team)
      .then((data) => {
        mem = { at: Date.now(), key, data };
        writeDisk(mem);
        return data;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  // Stale profile from this process or a previous run: serve it instantly,
  // refresh behind. Identity changes rotate the token, which changes the key.
  const stale = mem?.key === key ? mem : readDisk()?.key === key ? readDisk() : null;
  if (stale) {
    mem ??= stale;
    kick().catch(() => {});
    return stale.data;
  }

  // First contact for this identity — the one time the profile is worth a
  // wait. A failure here still reports signed IN: the token exists, and the
  // account menu can carry the error while the app works.
  try {
    return await kick();
  } catch (e) {
    return { loggedIn: true, tokenSource: tokenSource(), error: errMsg(e).slice(0, 200) };
  }
}

// Fire-and-forget cache warm for server boot (instrumentation.ts): by the
// time the browser opens, the profile is already on hand.
export function warmAccount(): void {
  getAccount().catch(() => {});
}
