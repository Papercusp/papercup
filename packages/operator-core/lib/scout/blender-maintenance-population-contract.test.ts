/**
 * Static recurrence guard for the mug/kettle/cup retirement boundary.
 *
 * These five retained Blender consumers must enumerate registered Blender
 * scopes. Reintroducing listStartedPots makes every sweep silently no-op when
 * the retired tier's started bits are all false. Runtime tests cover the
 * backlog-with-zero-scopes alarm; this source contract closes the import-level
 * regression that would disable all five consumers at once.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const RETAINED_CONSUMERS = [
  'packages/operator-core/lib/scout/draft-review-watchdog.ts',
  'packages/operator-core/lib/scout/outcome-refresh-sweep.ts',
  'packages/operator-core/lib/scout/ready-plan-autostart.ts',
  'packages/operator-core/lib/scout/signal-accumulator.ts',
  'packages/operator-core/lib/scout/ungraded-filings-watchdog.ts',
] as const;

function populationContractViolations(source: string): string[] {
  const violations: string[] = [];
  if (!/\blistBlenderMaintenanceScopes\b/.test(source)) {
    violations.push('missing registry-backed listBlenderMaintenanceScopes consumer');
  }
  if (/\blistStartedPots\b/.test(source)) {
    violations.push('depends on retired hive_started population through listStartedPots');
  }
  return violations;
}

describe('retained Blender maintenance population contract', () => {
  it('positive control rejects the pre-retirement population seam', () => {
    const oldSource = `
      import { listStartedPots } from '../pot/started';
      export async function sweep() { return listStartedPots(); }
    `;
    expect(populationContractViolations(oldSource)).toEqual([
      'missing registry-backed listBlenderMaintenanceScopes consumer',
      'depends on retired hive_started population through listStartedPots',
    ]);
  });

  for (const relativePath of RETAINED_CONSUMERS) {
    it(`${relativePath} is registry-derived, never hive_started-gated`, () => {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(populationContractViolations(source)).toEqual([]);
    });
  }
});
