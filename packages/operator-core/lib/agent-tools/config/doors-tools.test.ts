/**
 * doors-tools.test.ts — config:doors-get / config:doors-set / config:doors-set-session
 * (deterministic-context-carry P-023).
 *
 * The operator-state PG layer is an in-memory store (the REAL context-doors-config
 * sanitize/merge/prune logic runs); the gateway-control harness is a passthrough (its
 * dryRun/audit/revert orchestration has its own suite); identity is pinned to one
 * ownerId so the session binding is assertable.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/config/doors-tools.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.mock('../../operator-state-pg', () => ({
  readOperatorState: vi.fn(async (table: string) => (store.has(table) ? store.get(table) : null)),
  writeOperatorState: vi.fn(async (table: string, payload: unknown) => { store.set(table, payload); }),
  invalidateOperatorStateCache: vi.fn(),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su-test', source: 'omp-hook-session' }),
}));
// Passthrough control harness: run capturePrev → apply → verify without the audit write.
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(
    async (
      spec: {
        capturePrev: () => Promise<unknown>;
        apply: () => Promise<unknown>;
        verify?: (next: unknown) => Promise<{ ok: boolean }>;
        describe?: (prev: unknown) => unknown;
      },
      opts?: { dryRun?: boolean },
    ) => {
      const prev = await spec.capturePrev();
      if (opts?.dryRun) {
        return { dryRun: true, applied: false, reverted: false, preview: spec.describe?.(prev), auditId: null, next: undefined };
      }
      const next = await spec.apply();
      const verify = spec.verify ? await spec.verify(next) : undefined;
      return { dryRun: false, applied: true, reverted: false, verify, auditId: 'audit-test', next };
    },
  ),
}));

import { BAKED_DOOR_CONSTANTS } from '../../context-doors';
import type { ContextDoorsConfigRow } from '../../context-doors-config';

const getTool = (await import('./doors-get')).default;
const setTool = (await import('./doors-set')).default;
const setSessionTool = (await import('./doors-set-session')).default;

const TABLE = 'operator_context_doors_config';
const CTX = { role: 'operator' } as never;
type ToolOut = { data: Record<string, unknown> };

beforeEach(() => {
  store.clear();
});

describe('config:doors-set (workspace defaults)', () => {
  it('persists a sanitized patch, reports the effective constants + floor doors', async () => {
    const out = (await setTool.handler({ maxTurnFloorTokens: 10_000 }, CTX)) as ToolOut;
    expect((store.get(TABLE) as ContextDoorsConfigRow).defaults).toEqual({ maxTurnFloorTokens: 10_000 });
    expect(out.data.applied).toBe(true);
    expect((out.data.effectiveWorkspace as { maxTurnFloorTokens: number }).maxTurnFloorTokens).toBe(10_000);
    expect((out.data.floorWindowDoors as { maxTurn: number }).maxTurn).toBe(10_000);
    expect((out.data.verify as { ok: boolean }).ok).toBe(true);
  });

  it('rejects an all-invalid patch loudly (a doorSplit not summing to 1 is dropped)', async () => {
    await expect(
      setTool.handler({ doorSplit: { output: 0.9, resultEach: 0.2, resultSlots: 2, injections: 0.2 } }, CTX),
    ).rejects.toThrow(/sum to 1/);
    expect(store.has(TABLE)).toBe(false);
  });

  it('clear:true wipes the workspace layer back to baked', async () => {
    store.set(TABLE, { defaults: { maxTurnFloorTokens: 10_000 } } satisfies ContextDoorsConfigRow);
    const out = (await setTool.handler({ clear: true }, CTX)) as ToolOut;
    expect((store.get(TABLE) as ContextDoorsConfigRow).defaults).toBeUndefined();
    expect((out.data.effectiveWorkspace as { maxTurnFloorTokens: number }).maxTurnFloorTokens).toBe(
      BAKED_DOOR_CONSTANTS.maxTurnFloorTokens,
    );
  });

  it('dryRun previews without writing', async () => {
    const out = (await setTool.handler({ maxTurnFloorTokens: 10_000, dryRun: true }, CTX)) as ToolOut;
    expect(out.data.dryRun).toBe(true);
    expect(store.has(TABLE)).toBe(false);
  });

  it('requires a config-write role', async () => {
    await expect(setTool.handler({ maxTurnFloorTokens: 10_000 }, { role: 'worker' } as never)).rejects.toThrow(/role/);
  });
});

describe('config:doors-set-session (TTL = session, provenance-stamped)', () => {
  it('binds the override to the resolved identity with provenance, and reports the effective merge', async () => {
    const out = (await setSessionTool.handler({ compactionOverheadTokens: 6_000 }, CTX)) as ToolOut;
    const row = store.get(TABLE) as ContextDoorsConfigRow;
    const entry = row.sessions?.['su-test'];
    expect(entry?.overrides).toEqual({ compactionOverheadTokens: 6_000 });
    expect(entry?.setBy).toBe('su-test');
    expect(entry?.provenance).toBe('role:operator source:omp-hook-session');
    expect(typeof entry?.setAt).toBe('number');
    expect((out.data.effective as { compactionOverheadTokens: number }).compactionOverheadTokens).toBe(6_000);
    expect(out.data.ownerId).toBe('su-test');
  });

  it('the session layer wins over the workspace layer for its own keys only', async () => {
    await setTool.handler({ maxTurnFloorTokens: 10_000, compactionOverheadTokens: 5_000 }, CTX);
    const out = (await setSessionTool.handler({ compactionOverheadTokens: 7_000 }, CTX)) as ToolOut;
    const effective = out.data.effective as { maxTurnFloorTokens: number; compactionOverheadTokens: number };
    expect(effective.compactionOverheadTokens).toBe(7_000); // session wins
    expect(effective.maxTurnFloorTokens).toBe(10_000); // workspace shows through
  });

  it('clear:true drops the binding', async () => {
    await setSessionTool.handler({ compactionOverheadTokens: 6_000 }, CTX);
    const out = (await setSessionTool.handler({ clear: true }, CTX)) as ToolOut;
    expect((store.get(TABLE) as ContextDoorsConfigRow).sessions).toBeUndefined();
    expect(out.data.sessionOverride).toBeNull();
    expect((out.data.effective as { compactionOverheadTokens: number }).compactionOverheadTokens).toBe(
      BAKED_DOOR_CONSTANTS.compactionOverheadTokens,
    );
  });
});

describe('config:doors-get', () => {
  it('reads every layer: baked, workspace, your session (full), others (summary), effective + operating points', async () => {
    await setTool.handler({ maxTurnFloorTokens: 10_000 }, CTX);
    await setSessionTool.handler({ compactionOverheadTokens: 6_000 }, CTX);
    // A second session's override (written directly) shows as a summary, not in full.
    const row = store.get(TABLE) as ContextDoorsConfigRow;
    row.sessions!['su-other'] = { overrides: { maxTurnCapTokens: 20_000 }, setBy: 'su-other', setAt: Date.now(), provenance: 'x' };

    const out = (await getTool.handler({}, CTX)) as ToolOut;
    expect(out.data.baked).toEqual(BAKED_DOOR_CONSTANTS);
    expect(out.data.workspaceDefaults).toEqual({ maxTurnFloorTokens: 10_000 });
    expect((out.data.yourSessionOverride as { overrides: unknown }).overrides).toEqual({ compactionOverheadTokens: 6_000 });
    expect(out.data.otherSessionOverrides).toEqual([
      { ownerId: 'su-other', setBy: 'su-other', setAt: expect.any(Number), keys: ['maxTurnCapTokens'] },
    ]);
    const effective = out.data.effective as { maxTurnFloorTokens: number; compactionOverheadTokens: number };
    expect(effective).toMatchObject({ maxTurnFloorTokens: 10_000, compactionOverheadTokens: 6_000 });
    const points = out.data.operatingPoints as { floorWindowDoors: { maxTurn: number }; ornith204800: { hardTokens: number } };
    expect(points.floorWindowDoors.maxTurn).toBe(10_000);
    expect(points.ornith204800.hardTokens).toBe(204_800 - 10_000);
  });
});
