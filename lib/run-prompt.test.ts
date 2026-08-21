import { test } from "node:test";
import assert from "node:assert/strict";
import { firstPromptOf } from "./run-prompt.ts";
import type { Turn } from "./types";

const turn = (messages: Turn["messages"]): Turn => ({
  turnId: "t1",
  steps: [],
  messages,
  startedAt: null,
  endedAt: null,
  durationMs: null,
});

test("returns the first received message", () => {
  assert.equal(
    firstPromptOf([turn([{ type: "message.received", at: null, text: "do the thing" }])]),
    "do the thing",
  );
});

test("skips empty and whitespace-only messages", () => {
  assert.equal(
    firstPromptOf([
      turn([
        { type: "message.received", at: null, text: "  " },
        { type: "message.completed", at: null, text: "noise" },
        { type: "message.received", at: null, text: "real" },
      ]),
    ]),
    "real",
  );
});

test("no turns, no prompt", () => {
  assert.equal(firstPromptOf([]), null);
});
