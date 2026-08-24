import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidScheduleName, normalizeSessionIds } from "./schedule-name.ts";

test("accepts the file-derived names eve uses", () => {
  for (const ok of ["morning", "daily-digest.v2", "run_10k", "a"])
    assert.ok(isValidScheduleName(ok), `expected ${ok} to be valid`);
});

test("rejects path traversal, empties, and oversized names", () => {
  for (const bad of ["../etc", "a/b", "", ".".repeat(65), null, undefined, 42, {}])
    assert.ok(!isValidScheduleName(bad), `expected ${String(bad)} to be invalid`);
});

test("session id normalization keeps strings and drops everything else", () => {
  assert.deepEqual(normalizeSessionIds(["wrun_1", 42, null, "wrun_2"]), ["wrun_1", "wrun_2"]);
  assert.deepEqual(normalizeSessionIds(undefined), []);
  assert.deepEqual(normalizeSessionIds("wrun_1"), []);
});
