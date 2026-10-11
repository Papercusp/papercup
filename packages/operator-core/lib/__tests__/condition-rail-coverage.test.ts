import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrationCoverageProblems } from '../../../../scripts/lib/condition-rail-inventory.mjs';
import { listDegradationMechanisms } from '../system-health/degradation-watchdog';
import { RAIL_MIGRATION_CASES, RAIL_MIGRATION_COMPLETE_ITEMS } from '../degradation/rail-migration-cases';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/evidence/condition-rail-inventory-seed-2026-10-11.json', import.meta.url)), 'utf8'));

describe('condition-rail per-row executable coverage (P-017)', () => {
  it('has a matching executable case for every row in every completed migration', () => {
    expect(migrationCoverageProblems(manifest, RAIL_MIGRATION_CASES, RAIL_MIGRATION_COMPLETE_ITEMS,
      listDegradationMechanisms().map((mechanism) => mechanism.mechanism))).toEqual([]);
  });

  for (const testCase of RAIL_MIGRATION_CASES) {
    it(`${testCase.item}: ${testCase.id}`, async () => {
      const result = await testCase.run();
      expect(result.route).toBe(testCase.route);
      if (result.route === 'condition') {
        expect(result.openedKeys.length).toBeGreaterThan(0);
        expect([...result.openedKeys].sort()).toEqual([...result.resolvedKeys].sort());
      } else {
        expect(result.mechanism).toBe(testCase.mechanism);
        expect(result.observations.length).toBeGreaterThan(0);
        for (const observation of result.observations) {
          expect(observation.eligible).toBeGreaterThan(0);
          expect(observation.applied).toBeGreaterThanOrEqual(0);
          expect(observation.applied).toBeLessThanOrEqual(observation.eligible);
          expect(observation.reason.trim()).not.toBe('');
        }
        if (testCase.item === 'P-015') {
          expect(result.observations.some((row) => row.eligible === 1 && row.applied === 1)).toBe(true);
          expect(result.observations.some((row) => row.eligible === 1 && row.applied === 0)).toBe(true);
        }
      }
    });
  }

  it('catches missing cases, invalid routes, and unregistered observation mechanisms', () => {
    const row = { id: 'one', disposition: 'migrate', item: 'P-010', route: 'observation' };
    const fixture = { rows: [row], amendments: [] };
    expect(migrationCoverageProblems(fixture, [], ['P-010'], []).join()).toMatch(/has no case/);
    const testCase = { id: 'case', item: 'P-010', rowIds: ['one'], route: 'observation', mechanism: 'x', run: () => ({}) };
    expect(migrationCoverageProblems(fixture, [testCase], ['P-010'], []).join()).toMatch(/unregistered/);
    expect(migrationCoverageProblems(fixture, [testCase], ['P-010'], ['x'])).toEqual([]);
    expect(migrationCoverageProblems({ rows: [{ ...row, route: '' }], amendments: [] }, [], [], []).join()).toMatch(/missing route/);
  });
});
