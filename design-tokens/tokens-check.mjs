#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Regenerates design-token CSS outputs and fails if the working tree
// differs. Catches the drift case where someone edits a token source
// file but forgets `pnpm tokens` before committing.
//
// Usage: pnpm tokens:check  (called from CI / pre-commit / make check)

import { execSync } from "node:child_process";

const OUTPUTS = [
  "apps/operator/app/_brand-primitives.css",
  "apps/operator/app/_semantic.css",
  "design-tokens/primitives.tokens.json",
];

try {
  execSync("pnpm tokens", { stdio: "inherit" });
} catch (e) {
  console.error("✗ tokens regen failed");
  process.exit(e.status || 1);
}

const diff = execSync(`git --no-pager diff --stat -- ${OUTPUTS.join(" ")}`, { encoding: "utf8" });
if (diff.trim()) {
  console.error("\n✗ design-token outputs drifted from sources. Run 'pnpm tokens' and commit the diff:\n");
  console.error(diff);
  process.exit(1);
}
console.log("✓ design tokens in sync");
