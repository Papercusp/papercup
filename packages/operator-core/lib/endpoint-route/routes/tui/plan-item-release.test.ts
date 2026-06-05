/**
 * Unit tests for the pure `releaseDispatch` decision (P-005b release half). No
 * DB — the dispatch + reflect-rule path is the live-verified part (the same
 * tools the agent surface exercises); here we pin WHICH tool a put-back fires:
 * live execution record → work_items:release (reflect rules flip + drop the
 * lease), terminal-or-absent → bare plan_items:release (lease only).
 */
import { describe, it, expect } from 'vitest';
import { releaseDispatch } from './plan-item-release';

const scope = { harness: 'papercup', plan: 'my-plan', item: 'P-010' };

describe('releaseDispatch', () => {
  it('releases a live (non-terminal) work_item via work_items:release', () => {
    const d = releaseDispatch({ id: 'WI-42', state: 'wip', harness: 'papercup' }, scope);
    expect(d).toEqual({
      tool: 'work_items:release',
      args: { id: 'WI-42', harness: 'papercup' },
    });
  });

  it('omits harness from work_items:release args when the record has none (operator-scope issue-family)', () => {
    const d = releaseDispatch({ id: 'WI-7', state: 'open', harness: null }, scope);
    expect(d).toEqual({ tool: 'work_items:release', args: { id: 'WI-7' } });
  });

  it('falls back to the bare plan-item lease when no work_item exists', () => {
    const d = releaseDispatch(null, scope);
    expect(d).toEqual({
      tool: 'plan_items:release',
      args: { plan: 'my-plan', item: 'P-010', harness: 'papercup' },
    });
  });

  it.each(['passed', 'resolved', 'closed', 'done', 'deprecated', 'dropped'])(
    'falls back to the bare lease when the record is terminal (%s) — nothing live to release',
    (state) => {
      const d = releaseDispatch({ id: 'WI-9', state, harness: 'papercup' }, scope);
      expect(d.tool).toBe('plan_items:release');
      expect(d.args).toEqual({ plan: 'my-plan', item: 'P-010', harness: 'papercup' });
    },
  );

  it('omits harness from the bare-lease args when scope has none (tool defaults apply)', () => {
    const d = releaseDispatch(null, { plan: 'p', item: 'P-001' });
    expect(d).toEqual({ tool: 'plan_items:release', args: { plan: 'p', item: 'P-001' } });
  });
});
