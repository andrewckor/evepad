import type { Account } from "./types";

export function projectsRequestKey(account: Account | null | undefined): string | null {
  if (!account?.loggedIn) return null;
  const scope = account.scope?.id ?? account.scope?.slug ?? account.user?.username ?? "signed-in";
  return `/api/projects?scope=${encodeURIComponent(scope)}`;
}
