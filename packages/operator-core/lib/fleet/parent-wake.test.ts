/**
 * parent-wake.test.ts — wakeParentOnChildDeath BRANCH unit coverage (Gap 8).
 *
 * The integration rig (parent-wake.integration.test.ts) exercises the happy paths
 * against real PG. This unit test drives the three early-exits + the woken-mapping
 * with an INJECTED sql stub and a mocked wakeRecipients, so the branches are
 * deterministic and need no container:
 *   (a) wakeRecipients THROWS → resolves {parentWoken:false}, does NOT reject
 *       (the best-effort catch — load-bearing: the spawn's terminal status is
 *        already durable, a wake-fan error must downgrade, not propagate);
 *   (b) {woken:0} → parentWoken:false;
 *   (c) {woken:1} with a parent row → parentWoken:true, parentOwnerId===parent_spawn_id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ wakeRecipients: vi.fn() }));
vi.mock('../agent-tools/coordination/inbox-wake', () => ({ wakeRecipients: h.wakeRecipients }));

import { wakeParentOnChildDeath } from './parent-wake';
import type { Sql } from 'postgres';

const WS = 'default';

/** A minimal tagged-template sql stub that returns a fixed row set for the one
 *  SELECT wakeParentOnChildDeath issues — no PG, no container. */
function fakeSql(rows: unknown[]): Sql {
  const fn = (async () => rows) as unknown as Sql;
  return fn;
}

const spawnRow = (over: Record<string, unknown> = {}) => ({
  spawn_id: 'child-s1',
  parent_spawn_id: 'parent-s1',
  workspace_id: WS,
  session_owner: 'child-owner',
  status: 'failed',
  error_message: null,
  output_tail: null,
  exit_code: null,
  ...over,
});

beforeEach(() => {
  h.wakeRecipients.mockReset();
});

describe('wakeParentOnChildDeath — branch coverage (Gap 8, injected sql)', () => {
  it('(a) best-effort catch: wakeRecipients THROWS → resolves {parentWoken:false}, does NOT reject', async () => {
    h.wakeRecipients.mockRejectedValue(new Error('inbox-wake fan exploded'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The promise must RESOLVE (the terminal status is already durable); a reject
    // here would propagate a wake-fan error up the spawn-finish path.
    const result = await wakeParentOnChildDeath(fakeSql([spawnRow()]), 'child-s1', WS, 'failed');

    expect(result).toEqual({ parentWoken: false });
    expect(h.wakeRecipients).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[parent-wake]'));
    warn.mockRestore();
  });

  it('(b) {woken:0} → parentWoken:false (parent asleep/absent, nothing was re-invoked)', async () => {
    h.wakeRecipients.mockResolvedValue({ targets: ['parent-s1'], keys: [], woken: 0 });

    const result = await wakeParentOnChildDeath(fakeSql([spawnRow()]), 'child-s1', WS, 'failed');

    expect(result.parentWoken).toBe(false);
    // The parent ids still ride the result even when nothing woke.
    expect(result.parentSpawnId).toBe('parent-s1');
    expect(result.parentOwnerId).toBe('parent-s1');
  });

  it('(c) {woken:1} with a parent row → parentWoken:true, parentOwnerId===parent_spawn_id', async () => {
    h.wakeRecipients.mockResolvedValue({ targets: ['parent-s1'], keys: ['k'], woken: 1 });

    const result = await wakeParentOnChildDeath(fakeSql([spawnRow()]), 'child-s1', WS, 'failed');

    expect(result.parentWoken).toBe(true);
    expect(result.parentSpawnId).toBe('parent-s1');
    expect(result.parentOwnerId).toBe('parent-s1');
    // wakeRecipients is keyed on parent_spawn_id directly (the EI-108 fix).
    expect(h.wakeRecipients).toHaveBeenCalledWith(
      ['parent-s1'],
      expect.objectContaining({ source: 'spawn-finish', workspaceId: WS }),
    );
  });

  it('early-exit: no rows (spawn gone) → {parentWoken:false}, wakeRecipients never called', async () => {
    const result = await wakeParentOnChildDeath(fakeSql([]), 'ghost', WS, 'done');
    expect(result).toEqual({ parentWoken: false });
    expect(h.wakeRecipients).not.toHaveBeenCalled();
  });

  it('early-exit: row with null parent_spawn_id (orphan) → {parentWoken:false}, no wake', async () => {
    const result = await wakeParentOnChildDeath(
      fakeSql([spawnRow({ parent_spawn_id: null })]),
      'orphan',
      WS,
      'done',
    );
    expect(result).toEqual({ parentWoken: false });
    expect(h.wakeRecipients).not.toHaveBeenCalled();
  });
});
