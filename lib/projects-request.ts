import type { Account } from "./types";

export function accountScopeIdentity(account: Account | null | undefined): string | null {
  if (!account?.loggedIn) return null;
  return account.scope?.id ?? account.scope?.slug ?? account.user?.username ?? "signed-in";
}

export function projectsRequestKey(account: Account | null | undefined): string | null {
  const scope = accountScopeIdentity(account);
  if (!scope) return null;
  return `/api/projects?scope=${encodeURIComponent(scope)}`;
}
