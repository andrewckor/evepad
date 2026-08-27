import assert from "node:assert/strict";
import { test } from "node:test";
import { collectVercelProjectPages } from "./vercel-project-pages.ts";

const project = (id: string) => ({ id, name: id });

test("collectVercelProjectPages follows every cursor and aggregates the results", async () => {
  const cursors: Array<string | null> = [];
  const projects = await collectVercelProjectPages(async (until) => {
    cursors.push(until);
    if (until === null) {
      return { projects: [project("one")], pagination: { next: 42 } };
    }
    return { projects: [project("two")], pagination: { next: null } };
  });

  assert.deepEqual(cursors, [null, "42"]);
  assert.deepEqual(
    projects.map(({ id }) => id),
    ["one", "two"],
  );
});

test("collectVercelProjectPages rejects a repeated cursor", async () => {
  await assert.rejects(
    collectVercelProjectPages(async () => ({ pagination: { next: "same" } })),
    /repeated cursor/,
  );
});
