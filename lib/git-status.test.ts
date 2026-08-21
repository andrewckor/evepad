import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitStatus } from "./git-status.ts";

test("clean tree with an upstream", () => {
  const s = parseGitStatus("## main...origin/main\n");
  assert.equal(s.branch, "main");
  assert.equal(s.upstream, true);
  assert.equal(s.ahead, 0);
  assert.equal(s.changed, 0);
});

test("counts every non-head line as a change", () => {
  const s = parseGitStatus("## feat/x...origin/feat/x [ahead 2]\n M a.ts\n?? new.ts\n");
  assert.equal(s.changed, 2);
  assert.equal(s.ahead, 2);
  assert.equal(s.branch, "feat/x");
});

test("no upstream and no commits yet", () => {
  const s = parseGitStatus("## master\n");
  assert.equal(s.upstream, false);
  assert.equal(s.branch, "master");
});

test("empty output degrades to nulls, not throws", () => {
  const s = parseGitStatus("");
  assert.equal(s.branch, null);
  assert.equal(s.changed, 0);
});
