#!/usr/bin/env node
// Pre-commit hook: run `oxfmt` on staged files and re-stage the results.
// Ported from vercel/eve's hook of the same name (pnpm exec → npx).
//
// * Extension set is not hard-coded: oxfmt skips files it doesn't recognize
//   when at least one recognized file is in the batch, and exits 2 ("no
//   target files") when every file is unknown — treated as a no-op, so the
//   hook tracks whatever oxfmt supports.
// * Partially-staged files are NOT formatted: formatting in place and
//   re-adding would silently pull unstaged edits into the commit. Skipped
//   with a warning instead.
// * Only Added / Copied / Modified / Renamed index entries are considered.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const OXFMT_NO_TARGETS_EXIT = 2;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", ...opts });
  if (result.error) throw result.error;
  return result;
}

function runGitNameList(args) {
  const out = run("git", [...args, "-z"]);
  if (out.status !== 0) {
    process.stderr.write(out.stderr || `git ${args.join(" ")} failed\n`);
    process.exit(out.status ?? 1);
  }
  return out.stdout.split("\0").filter(Boolean);
}

const stagedAll = runGitNameList(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
const unstaged = new Set(runGitNameList(["diff", "--name-only"]));
const stagedOnDisk = stagedAll.filter((p) => existsSync(resolve(REPO_ROOT, p)));

const safe = [];
for (const p of stagedOnDisk) {
  if (unstaged.has(p)) {
    process.stderr.write(`oxfmt: skipping partially-staged file (has unstaged changes): ${p}\n`);
  } else {
    safe.push(p);
  }
}

if (safe.length === 0) process.exit(0);

const fmt = run("npx", ["oxfmt", "--", ...safe], { stdio: ["ignore", "inherit", "inherit"] });
if (fmt.status === OXFMT_NO_TARGETS_EXIT) process.exit(0);
if (fmt.status !== 0) process.exit(fmt.status ?? 1);

const add = run("git", ["add", "--", ...safe], { stdio: ["ignore", "inherit", "inherit"] });
if (add.status !== 0) process.exit(add.status ?? 1);
