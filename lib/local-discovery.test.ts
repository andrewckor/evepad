import { test } from "node:test";
import assert from "node:assert/strict";
import { discoveredAgentName, isEveAgentPackage } from "./local-discovery-utils.ts";

test("recognizes eve in either dependency collection", () => {
  assert.equal(isEveAgentPackage({ dependencies: { eve: "^5" } }), true);
  assert.equal(isEveAgentPackage({ devDependencies: { eve: "^5" } }), true);
  assert.equal(isEveAgentPackage({ dependencies: { next: "latest" } }), false);
});

test("prefers the linked project name and falls back to package or folder", () => {
  assert.equal(
    discoveredAgentName({ name: "package-agent" }, "folder-agent", "linked-agent"),
    "linked-agent",
  );
  assert.equal(discoveredAgentName({ name: "package-agent" }, "folder-agent"), "package-agent");
  assert.equal(discoveredAgentName({ name: "@scope/not-valid" }, "folder-agent"), "folder-agent");
});
