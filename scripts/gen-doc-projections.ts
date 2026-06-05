/**
 * gen-doc-projections.ts — the umbrella runner for every Starlight projection
 * generator (starlight-projection-generators-2026-06-05 P-006).
 *
 * Runs each `gen-doc-<name>.ts` as its own child process (they side-effect on
 * import + some `process.exit`, so they can't share one process). Honors the
 * gating tier (D-002): a DETERMINISTIC projector that fails (or, under --check,
 * drifts) fails this runner; an ADVISORY one (heavy import / PG-dependent) only
 * warns. CI gates the deterministic three individually; this is the local
 * one-shot "regenerate / verify everything".
 *
 *   npm run gen:doc-projections          # regenerate all five pages
 *   npm run gen:doc-projections:check    # verify (gating three + advisory two)
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/doc-projection';

const CHECK = process.argv.includes('--check');

const PROJECTORS: Array<{ name: string; gating: boolean }> = [
  { name: 'blueprint-catalog', gating: true },
  { name: 'role-registry', gating: true },
  { name: 'insights-index', gating: true },
  { name: 'tool-catalog', gating: false },
  { name: 'plans-index', gating: false },
];

let gatingFailure = false;
for (const p of PROJECTORS) {
  const script = join(REPO_ROOT, 'scripts', `gen-doc-${p.name}.ts`);
  const res = spawnSync('npx', ['tsx', script, ...(CHECK ? ['--check'] : [])], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (res.status !== 0) {
    if (p.gating) {
      gatingFailure = true;
      process.stderr.write(`✗ ${p.name} failed (gating)\n`);
    } else {
      process.stdout.write(`⚠ ${p.name} exited ${res.status ?? '?'} (advisory — not gating)\n`);
    }
  }
}
process.exit(gatingFailure ? 1 : 0);
