#!/usr/bin/env node
/**
 * typecheck (root scripts) — the same per-file baseline gate as `lint:tsc`, pointed at
 * the dedicated root-scripts project.
 *
 * WI-38284: the repository's load-bearing `scripts/*.ts` CLIs were not covered by any
 * typecheck project. `tsconfig.declarations.json` is deliberately not a substitute: its
 * hand-maintained `files` list exists to emit declarations for selected `.mjs` inputs,
 * not to check every future TypeScript CLI. This thin entrypoint keeps the policy in
 * `scripts/lib/tsc-baseline-gate.mjs` and owns only this project's command, baseline,
 * and label.
 *
 * Usage:
 *   npm run lint:tsc:scripts
 *   npm run lint:tsc:scripts -- --files=scripts/leak-ratchet.ts
 *   npm run lint:tsc:scripts -- --update
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTscBaselineGate } from './lib/tsc-baseline-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = resolve(ROOT, 'scripts/.tsc-baseline.json');

/** @type {string} */
export const TSC_COMMAND =
  'npx tsc -p scripts/tsconfig.json --noEmit --incremental false';

async function main() {
  await runTscBaselineGate({
    root: ROOT,
    tscCommand: TSC_COMMAND,
    baselineFile,
    label: 'scripts',
    argv: process.argv.slice(2),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    // A crashed gate must never read as a clean typecheck.
    console.error(err);
    process.exit(1);
  });
}
