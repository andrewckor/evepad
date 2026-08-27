import assert from "node:assert/strict";
import test from "node:test";
import { localLinkVisible } from "./project-visibility.ts";

const projects = new Set(["prj_current"]);
const orgs = new Set(["team_current"]);

test("unlinked local checkouts remain visible", () => {
  assert.equal(localLinkVisible({ projectId: null, orgId: null }, projects, orgs), true);
});

test("a fully matching Vercel link is visible", () => {
  assert.equal(
    localLinkVisible({ projectId: "prj_current", orgId: "team_current" }, projects, orgs),
    true,
  );
});

test("links from another project or account are hidden", () => {
  assert.equal(
    localLinkVisible({ projectId: "prj_other", orgId: "team_current" }, projects, orgs),
    false,
  );
  assert.equal(
    localLinkVisible({ projectId: "prj_current", orgId: "team_other" }, projects, orgs),
    false,
  );
});

test("partial Vercel links fail closed", () => {
  assert.equal(localLinkVisible({ projectId: "prj_current", orgId: null }, projects, orgs), false);
  assert.equal(localLinkVisible({ projectId: null, orgId: "team_current" }, projects, orgs), false);
});
