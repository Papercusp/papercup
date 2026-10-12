import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';
import * as recorder from '../degradation/fallback-observations';
import { inventoryTree, migrationCoverageProblems } from '../../../../scripts/lib/condition-rail-inventory.mjs';
import { listDegradationMechanisms } from '../system-health/degradation-watchdog';
import { RAIL_MIGRATION_CASES, RAIL_MIGRATION_COMPLETE_ITEMS } from '../degradation/rail-migration-cases';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/evidence/condition-rail-inventory-seed-2026-10-11.json', import.meta.url)), 'utf8'));

// Some real producers import configuration whose readiness promise reads the
// operator-state store during module evaluation. Install this dependency seam
// before imports, rather than waiting for beforeEach after the read has started.
const operatorState = vi.hoisted(() => ({
  read: vi.fn(async () => null),
  write: vi.fn(async () => undefined),
}));
vi.mock('../operator-state-pg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../operator-state-pg')>()),
  readOperatorState: operatorState.read,
  writeOperatorState: operatorState.write,
}));

// These cases verify real producers at their dependency seams. Durable INSERTs
// have separate integration coverage; never let incidental imported telemetry
// flush against the unit fixture's database. A case replaces this sink to assert
// its exact observation; the default also covers import-time initialization.
beforeEach(() => { vi.spyOn(recorder, 'observeFallback').mockReturnValue(true); });
afterEach(() => { recorder._resetFallbackObservationsForTests(); vi.restoreAllMocks(); });

describe('condition-rail per-row executable coverage (P-017)', () => {
  it('isolates import-time release configuration reads from real PostgreSQL', async () => {
    const blockedBefore = readRealPgRailBlocks().blocked;
    expect(blockedBefore).toBe(0);
    const config = await import('../release-checkpoint-config');
    await config.releaseCheckpointConfigReady;
    expect(operatorState.read).toHaveBeenCalledWith('operator_release_checkpoint_config');
    expect(config.releaseCheckpointConfig()).toEqual(config.RELEASE_CHECKPOINT_DEFAULTS);
    expect(readRealPgRailBlocks().blocked).toBe(blockedBefore);
  });

  it('has a matching executable case for every row in every completed migration', () => {
    expect(migrationCoverageProblems(manifest, RAIL_MIGRATION_CASES, RAIL_MIGRATION_COMPLETE_ITEMS,
      listDegradationMechanisms().map((mechanism) => mechanism.mechanism))).toEqual([]);
  });

  it('retains each implemented P-011 original site identity on the rail', () => {
    const live = inventoryTree(fileURLToPath(new URL('../../../../', import.meta.url)));
    expect(live.unreadable).toBe(0);
    for (const testCase of RAIL_MIGRATION_CASES.filter((entry) => entry.item === 'P-011')) {
      for (const id of testCase.rowIds) {
        expect(manifest.rows.find((row: { id: string }) => row.id === id), id).toBeDefined();
        expect(live.sites.find((site: { id: string }) => site.id === id)?.onRail, id).toBe(true);
      }
    }
  }, 120_000);

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
