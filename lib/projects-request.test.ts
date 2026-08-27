import assert from "node:assert/strict";
import { test } from "node:test";
import { accountScopeIdentity, projectsRequestKey } from "./projects-request.ts";

test("projectsRequestKey is disabled while signed out", () => {
  assert.equal(projectsRequestKey(undefined), null);
  assert.equal(projectsRequestKey({ loggedIn: false }), null);
});

test("projectsRequestKey scopes project data to the active identity", () => {
  assert.equal(
    projectsRequestKey({
      loggedIn: true,
      scope: { id: "team_123", slug: "team-slug" },
      user: { username: "andrew" },
    }),
    "/api/projects?scope=team_123",
  );
  assert.equal(
    projectsRequestKey({ loggedIn: true, user: { username: "name with spaces" } }),
    "/api/projects?scope=name%20with%20spaces",
  );
  assert.equal(projectsRequestKey({ loggedIn: true }), "/api/projects?scope=signed-in");
});

test("accountScopeIdentity can scope other account-owned requests", () => {
  assert.equal(accountScopeIdentity({ loggedIn: false }), null);
  assert.equal(
    accountScopeIdentity({ loggedIn: true, scope: { id: "team_123", slug: "ignored" } }),
    "team_123",
  );
});
