import { test } from "node:test";
import assert from "node:assert/strict";
import { instructionsTooLarge, MAX_INSTRUCTIONS_BYTES } from "./instructions.ts";

test("accepts normal documents and rejects non-strings", () => {
  assert.ok(!instructionsTooLarge("# hi"));
  assert.ok(instructionsTooLarge(undefined));
  assert.ok(instructionsTooLarge(42));
});

test("caps by utf8 bytes, not characters", () => {
  // Two-byte chars double the byte cost at half the string length.
  const twoByte = "é".repeat(MAX_INSTRUCTIONS_BYTES / 2 + 1);
  assert.ok(instructionsTooLarge(twoByte));
  const fits = "é".repeat(MAX_INSTRUCTIONS_BYTES / 2 - 1);
  assert.ok(!instructionsTooLarge(fits));
});
