import { test } from "node:test";
import assert from "node:assert/strict";
import { deployArgs, isDeployVariant } from "./deploy-command.ts";

test("production deploy promotes with --prod", () => {
  const args = deployArgs("deploy");
  assert.ok(args.includes("--prod"), "expected --prod");
  assert.equal(args[args.length - 2], "deploy");
});

test("preview deploy leaves aliases alone", () => {
  const args = deployArgs("deploy-preview");
  assert.ok(!args.includes("--prod"));
  assert.equal(args[args.length - 1], "deploy");
});

test("both targets resolve the same CLI binary", () => {
  assert.equal(deployArgs("deploy")[0], deployArgs("deploy-preview")[0]);
});

test("variant guard accepts only the two deploy variants", () => {
  assert.ok(isDeployVariant("deploy"));
  assert.ok(isDeployVariant("deploy-preview"));
  assert.ok(!isDeployVariant("deploy-prod"));
  assert.ok(!isDeployVariant(""));
  assert.ok(!isDeployVariant(null));
});
