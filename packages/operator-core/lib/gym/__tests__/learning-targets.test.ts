/**
 * Learning-system gym-target registration (self-learning-frontier P-048 / FB-23).
 * Pins the reflexive-close safety rails: every declared judging signal resolves in
 * GYM_SIGNAL_REGISTRY (a typo would silently skip judging), registration writes
 * ONLY dark rows (enabled:false + null budget — D-001/D-004), it never mutates an
 * existing row (owner enable/budget is sovereign), and targets without a real
 * prompt-override surface (or with an unconfigured runner) get no row at all —
 * the gym-cycle tick must never run a code-constructed persona as a generic
 * worker over the synthetic substrate.
 */
import { describe, test, expect } from 'vitest';
import type { Sql } from 'postgres';
import {
  LEARNING_GYM_TARGETS,
  validateLearningTargetSignals,
  registerLearningGymTargets,
} from '../learning-targets';

/**
 * Tagged-template fake Sql: SELECTs answer from `selectRows`, INSERTs are
 * captured with their bound values (setAutoloop's column order).
 */
function fakeSql(selectRows: unknown[]): { sql: Sql; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (/insert/i.test(text)) {
      inserts.push(values);
      return [];
    }
    return selectRows;
  }) as unknown as Sql;
  return { sql, inserts };
}

describe('the declared targets', () => {
  test('exactly the three learning-system roles, each judged by registry-known signals', () => {
    expect(LEARNING_GYM_TARGETS.map((t) => t.key).sort()).toEqual([
      'implement-worker',
      'scout-ideators',
      'triage-classifier',
    ]);
    expect(validateLearningTargetSignals()).toEqual([]);
  });

  test('only the implement worker has the prompt-override surface today', () => {
    const overridable = LEARNING_GYM_TARGETS.filter((t) => t.promptSurface === 'prompt-override');
    expect(overridable.map((t) => t.key)).toEqual(['implement-worker']);
    expect(overridable[0].blueprintId).toBe('implement');
  });
});

describe('registerLearningGymTargets', () => {
  const WS = 'ws-test';

  test('creates the implement-worker row DARK; persona/code surfaces are skipped, never rowed', async () => {
    const { sql, inserts } = fakeSql([]); // no existing rows
    const result = await registerLearningGymTargets(sql, { workspaceId: WS, implementRunnerSlug: 'implement-runner' });

    expect(result.created).toEqual(['implement-worker']);
    expect(result.skipped.map((s) => s.key).sort()).toEqual(['scout-ideators', 'triage-classifier']);
    expect(inserts).toHaveLength(1);
    // setAutoloop column order: workspace_id, harness_slug, enabled, budget_usd, …
    const [workspaceId, harnessSlug, enabled, budgetUsd] = inserts[0];
    expect(workspaceId).toBe(WS);
    expect(harnessSlug).toBe('implement-runner');
    expect(enabled).toBe(false); // D-001: dark
    expect(budgetUsd).toBeNull(); // D-004: unbudgeted → the tick refuses unattended
  });

  test('an existing row is left untouched — re-registration never flips an owner enable', async () => {
    const { sql, inserts } = fakeSql([
      { workspace_id: WS, harness_slug: 'implement-runner', enabled: 't', budget_usd: 5, spent_usd: 0, status: 'idle', last_cycle: null, last_cycle_at: null, updated_at: 1 },
    ]);
    const result = await registerLearningGymTargets(sql, { workspaceId: WS, implementRunnerSlug: 'implement-runner' });
    expect(result.existing).toEqual(['implement-worker']);
    expect(result.created).toEqual([]);
    expect(inserts).toHaveLength(0);
  });

  test('an unconfigured implement runner is a skip, not an invented slug', async () => {
    const { sql, inserts } = fakeSql([]);
    const result = await registerLearningGymTargets(sql, { workspaceId: WS, implementRunnerSlug: null });
    expect(result.created).toEqual([]);
    expect(result.skipped.find((s) => s.key === 'implement-worker')?.reason).toMatch(/unconfigured/);
    expect(inserts).toHaveLength(0);
  });
});
