/**
 * EI-19418147529720290 live verification: run the REAL probe against the REAL box
 * and check the one case that motivated the fix — the window-dead scope holding the
 * staging operator must come back `live-service-held`, not counted as reclaimable.
 */
import { readFileSync } from 'node:fs';
import { nodeCgroupFs } from '../packages/operator-core/lib/task-manager/cgroup-read';
import {
  censusTerminalResidue,
  resolveTerminalSliceAbs,
} from '../packages/operator-core/lib/task-manager/terminal-residue-census';
import { nodeResidueLivenessProbe } from '../packages/operator-core/lib/task-manager/residue-liveness-probe';

const days = (ms: number | null) => (ms === null ? '   ?  ' : `${(ms / 86_400_000).toFixed(1)}d`.padStart(6));

function main() {
  const mine = readFileSync('/proc/self/cgroup', 'utf8').trim().split('::')[1] ?? '';
  const root = mine.slice(0, mine.indexOf('.service') + '.service'.length);
  const slice = resolveTerminalSliceAbs(root);
  if (!slice) throw new Error('no user manager root');

  const before = censusTerminalResidue(slice, nodeCgroupFs);
  const t0 = Date.now();
  const after = censusTerminalResidue(slice, nodeCgroupFs, { probe: nodeResidueLivenessProbe() });
  const probeMs = Date.now() - t0;

  console.log(`slice scopes=${after.scopesTotal} dead=${after.scopesDead} unprobeable=${after.unprobeable}`);
  console.log(`probe cost: ${probeMs}ms\n`);

  console.log('BEFORE (no probe):', `${before.scopesDead} dead — stale=${before.deadStale} live=${before.deadLiveServiceHeld} indet=${before.deadIndeterminate}`);
  console.log('AFTER  (probed)  :', `${after.scopesDead} dead — stale=${after.deadStale} live=${after.deadLiveServiceHeld} indet=${after.deadIndeterminate}\n`);

  console.log('scope'.padEnd(26), 'pids'.padStart(5), 'age'.padStart(7), '  disposition');
  for (const d of [...after.dead].sort((a, b) => (b.oldestPidAgeMs ?? 0) - (a.oldestPidAgeMs ?? 0))) {
    console.log(d.scope.slice(10, 34).padEnd(26), String(d.pidCount).padStart(5), days(d.oldestPidAgeMs), '  ' + d.disposition);
  }

  // The regression this exists to prevent.
  const staging = after.dead.find((d) => d.scope.includes('6bcb8b08'));
  console.log('\n--- the case that motivated the fix ---');
  if (!staging) {
    console.log('?? vte-spawn-6bcb8b08 is no longer a dead scope (its window may have been reopened/closed since 08:00Z)');
  } else if (staging.disposition === 'live-service-held') {
    console.log('✅ vte-spawn-6bcb8b08 (the staging operator, :3170) => live-service-held — correctly NOT reclaimable');
  } else {
    console.log(`❌ REGRESSION: vte-spawn-6bcb8b08 => ${staging.disposition}, but it serves :3170`);
    process.exit(1);
  }

  const partition = after.deadStale + after.deadLiveServiceHeld + after.deadIndeterminate;
  console.log(partition === after.scopesDead ? '✅ dispositions partition scopesDead' : `❌ partition ${partition} != ${after.scopesDead}`);
}

main();
