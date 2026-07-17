#!/usr/bin/env node
/**
 * typecheck (operator-vite) — the SAME per-file baseline gate as `lint:tsc` (operator-core),
 * pointed at apps/operator-vite instead.
 *
 * EI-847: a raw `tsc -p apps/operator-vite/tsconfig.json --noEmit` floods with hundreds of
 * PRE-EXISTING errors from files transitively imported into the SPA's type graph (native-module
 * ambient-type gaps in packages/operator-core's p2p/hyperbee layer, a few genuine unrelated
 * bugs elsewhere) — an agent editing ONE operator-vite component gets no clean signal for
 * their own file and has to `| grep MyComponent` and hope nothing cascades. This is exactly the
 * problem `scripts/lint-tsc.mjs` already solved for operator-core (P-010/WI-4535): gate each
 * file against its OWN baseline, name regressions, and use `--mine` to scope the check to files
 * you actually changed. See `scripts/lib/tsc-baseline-gate.mjs` for the shared policy.
 *
 * Usage:
 *   npm run lint:tsc:operator-vite              # any file above its baseline fails, named
 *   npm run lint:tsc:operator-vite -- --mine    # only fail on regressions in files YOU changed
 *   npm run lint:tsc:operator-vite -- --update  # lower each improved file's baseline (never raises)
 *
 * Also wired as `apps/operator-vite`'s own `npm run typecheck` (replacing the old raw
 * `tsc --noEmit`), so the fleet-brief `npm run typecheck --if-present` idiom (EI-6479) gets a
 * clean, attributable signal there too instead of a flood.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTscBaselineGate } from './lib/tsc-baseline-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = resolve(ROOT, 'apps/operator-vite/.tsc-baseline.json');

// `--incremental false` for the same reason as operator-core's TSC_COMMAND (EI-487): a warm
// tsconfig.tsbuildinfo can under-report errors in affected-but-not-yet-reindexed files, which
// would silently ratchet a file's baseline down on `--update` and false-red a later fresh run.
export const TSC_COMMAND =
  'npx tsc -p apps/operator-vite/tsconfig.json --noEmit --incremental false';

function main() {
  runTscBaselineGate({
    root: ROOT,
    tscCommand: TSC_COMMAND,
    baselineFile,
    label: 'operator-vite',
    argv: process.argv.slice(2),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
