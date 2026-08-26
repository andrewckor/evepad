import { test } from "node:test";
import assert from "node:assert/strict";
import { evalsNoteFromFailure } from "./evals-note.ts";

test("eve's own no-evals exit becomes a friendly empty state", () => {
  const n = evalsNoteFromFailure("No evals found. Create files under evals/", "x");
  assert.equal(n.kind, "empty");
  assert.match(n.message, /evals\//);
});

test("anything else is an error carrying the CLI's words", () => {
  const n = evalsNoteFromFailure("cannot import module", "fallback");
  assert.equal(n.kind, "error");
  assert.equal(n.message, "cannot import module");
});

test("a blank failure falls back", () => {
  const n = evalsNoteFromFailure(undefined, "spawn failed");
  assert.equal(n.kind, "error");
  assert.equal(n.message, "spawn failed");
});
