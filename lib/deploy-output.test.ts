import { test } from "node:test";
import assert from "node:assert/strict";
import { foldLines, readDeployOutput } from "./deploy-output.ts";

test("spinner frames fold to their final text instead of piling up", () => {
  let lines = foldLines([], "Deploying outputs");
  lines = foldLines(lines, "\rDeploying outputs...");
  lines = foldLines(lines, "\r✓ Ready in 15s\n");
  assert.deepEqual(lines, ["✓ Ready in 15s", ""]);
});

test("private-mode sequences are stripped, not just colours", () => {
  const lines = foldLines([], "\x1b[?25hProduction https://x.vercel.app\n");
  assert.equal(lines[0], "Production https://x.vercel.app");
});

test("a running deploy has no verdict yet", () => {
  assert.equal(readDeployOutput(foldLines([], "Building…")).state, "running");
});

test("success reads the aliased production URL", () => {
  const out = foldLines(
    [],
    "Production https://x0-abc-team.vercel.app\n▲ Aliased https://x0-eve.vercel.app\n✓ Ready in 15s\n[process exited 0]\n",
  );
  const v = readDeployOutput(out);
  assert.equal(v.state, "success");
  assert.equal(v.url, "https://x0-eve.vercel.app");
});

test("non-zero exit is a failure even with URLs present", () => {
  const v = readDeployOutput(foldLines([], "Error: build failed\n[process exited 1]\n"));
  assert.equal(v.state, "failed");
});

test("falls back to any vercel.app URL when no alias line exists", () => {
  const v = readDeployOutput(foldLines([], "https://app-vercel.app ready\n[process exited 0]\n"));
  assert.equal(v.state, "success");
  assert.equal(v.url, "https://app-vercel.app");
});
