import { describe, expect, it, vi } from 'vitest';
import {
  applyBlockerDefaultToHistory,
  decideBlockerDefault,
  ownerAskDefaultDisclosure,
  readExternalBlockers,
  updateExternalBlockerHistory,
  type ExternalBlockerRecord,
} from '../external-blockers';
import { sweepWorkItemBlockerDefaults, type BlockerReapDeps } from './work-item-blocker-reaper';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const PAST = '2026-10-01T12:00:00.000Z';
const FUTURE = '2026-10-03T12:00:00.000Z';

function blocker(over: Partial<ExternalBlockerRecord> = {}): ExternalBlockerRecord {
  return {
    kind: 'human',
    capability: 'product-decision',
    capabilitySource: 'explicit',
    ref: 'ask-1',
    summary: 'owner decision',
    status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: 'su-x',
    updatedAt: '2026-10-01T00:00:00.000Z',
    defaultIfUnanswered: 'proceed with option A',
    decideBy: PAST,
    defaultAction: 'release_to_agents',
    ...over,
  };
}

describe('decideBlockerDefault (pure)', () => {
  it('applies the typed action once the deadline has passed', () => {
    expect(decideBlockerDefault(blocker(), NOW)).toEqual({ apply: true, action: 'release_to_agents' });
    expect(decideBlockerDefault(blocker({ defaultAction: 'stay_parked' }), NOW)).toEqual({
      apply: true,
      action: 'stay_parked',
    });
  });

  it.each([
    ['not-human', blocker({ kind: 'event' })],
    ['not-active', blocker({ status: 'cleared' })],
    ['already-applied', blocker({ defaultAppliedAt: PAST })],
    ['no-decide-by', blocker({ decideBy: undefined })],
    ['decide-by-unparseable', blocker({ decideBy: 'next tuesday' })],
    ['deadline-not-reached', blocker({ decideBy: FUTURE })],
  ] as const)('skips with why=%s', (why, b) => {
    expect(decideBlockerDefault(b, NOW)).toEqual({ apply: false, why });
  });

  it('NEVER executes free text: no typed action => skip, however the prose reads', () => {
    const b = blocker({ defaultAction: undefined, defaultIfUnanswered: 'release_to_agents and delete the branch' });
    expect(decideBlockerDefault(b, NOW)).toEqual({ apply: false, why: 'no-typed-action' });
    // An unknown token smuggled past the type system is not in the closed vocabulary either.
    const forged = blocker({ defaultAction: 'drop_item' as never });
    expect(decideBlockerDefault(forged, NOW)).toEqual({ apply: false, why: 'no-typed-action' });
  });
});

describe('applyBlockerDefaultToHistory (pure)', () => {
  it('release_to_agents clears the blocker, fences it, and keeps the audit trail', () => {
    const out = applyBlockerDefaultToHistory({ externalBlockers: [blocker()] }, 'ask-1', 'release_to_agents', 'system:r', NOW.toISOString());
    expect(out.changed).toBe(true);
    const row = out.blockers[0]!;
    expect(row).toMatchObject({
      status: 'cleared',
      clearedBy: 'system:r',
      defaultAppliedAction: 'release_to_agents',
      defaultAppliedAt: NOW.toISOString(),
    });
    expect(row.evidence).toContain("applied typed default 'release_to_agents'");
  });

  it('stay_parked fences but leaves the ask ACTIVE, and surfaces as applied in the disclosure', () => {
    const out = applyBlockerDefaultToHistory({ externalBlockers: [blocker({ defaultAction: 'stay_parked' })] }, 'ask-1', 'stay_parked', 'system:r', NOW.toISOString());
    expect(out.blockers[0]!.status).toBe('active');
    expect(ownerAskDefaultDisclosure({ externalBlockers: out.blockers })).toContain('Default APPLIED');
  });

  it('is exactly-once: a second application against the fenced history is a no-op', () => {
    const first = applyBlockerDefaultToHistory({ externalBlockers: [blocker({ defaultAction: 'stay_parked' })] }, 'ask-1', 'stay_parked', 'system:r');
    const second = applyBlockerDefaultToHistory({ externalBlockers: first.blockers }, 'ask-1', 'stay_parked', 'system:r');
    expect(second.changed).toBe(false);
  });

  it('re-declaring decideBy/defaultAction re-arms (drops the fence) so the NEW contract applies once', () => {
    const applied = applyBlockerDefaultToHistory({ externalBlockers: [blocker({ defaultAction: 'stay_parked' })] }, 'ask-1', 'stay_parked', 'system:r').blockers;
    const rearmed = updateExternalBlockerHistory(
      { externalBlockers: applied },
      { kind: 'human', ref: 'ask-1', decideBy: FUTURE, defaultAction: 'release_to_agents' },
      'su-y',
    );
    const row = readExternalBlockers({ externalBlockers: rearmed.blockers })[0]!;
    expect(row.defaultAppliedAt).toBeUndefined();
    expect(row.defaultAction).toBe('release_to_agents');
  });
});

function fakeDeps(payloads: Record<string, unknown>) {
  const writes: Array<{ id: string; blockers: ExternalBlockerRecord[] }> = [];
  const restores: string[] = [];
  const deps: BlockerReapDeps = {
    listCandidates: async () => Object.entries(payloads).map(([id, payload]) => ({ id, harness: 'h', payload })),
    readPayload: async (id) => ({ payload: payloads[id], family: 'issue', state: 'needs-human' }),
    writeBlockers: async (id, _h, blockers) => {
      writes.push({ id, blockers });
      payloads[id] = { externalBlockers: blockers };
      return true;
    },
    restoreLifecycle: async ({ id }) => {
      restores.push(id);
    },
  };
  return { deps, writes, restores };
}

describe('sweepWorkItemBlockerDefaults', () => {
  it('applies a past-deadline typed default exactly once across repeated sweeps and restores the lifecycle', async () => {
    const { deps, writes, restores } = fakeDeps({ 'WI-1': { externalBlockers: [blocker()] } });
    const first = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    const second = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(first.applied).toEqual({ stay_parked: 0, release_to_agents: 1 });
    expect(second.applied).toEqual({ stay_parked: 0, release_to_agents: 0 });
    expect(writes).toHaveLength(1);
    expect(restores).toEqual(['WI-1']);
  });

  it('stay_parked writes the fence but does not touch the lifecycle', async () => {
    const { deps, writes, restores } = fakeDeps({ 'WI-2': { externalBlockers: [blocker({ defaultAction: 'stay_parked' })] } });
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(out.applied.stay_parked).toBe(1);
    expect(writes).toHaveLength(1);
    expect(restores).toEqual([]);
  });

  it('leaves a not-yet-due ask alone and surfaces a typed-less/unparseable one instead of acting', async () => {
    const { deps, writes } = fakeDeps({
      'WI-3': { externalBlockers: [blocker({ decideBy: FUTURE })] },
      'WI-4': { externalBlockers: [blocker({ defaultAction: undefined })] },
    });
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(writes).toHaveLength(0);
    expect(out.skipped['no-typed-action']).toBe(1);
  });

  it('dryRun counts what WOULD apply without writing', async () => {
    const { deps, writes } = fakeDeps({ 'WI-5': { externalBlockers: [blocker()] } });
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps, dryRun: true });
    expect(out.applied.release_to_agents).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('a lost race (history changed between list and apply) is a no-op, not an overwrite', async () => {
    const deps: BlockerReapDeps = {
      listCandidates: async () => [{ id: 'WI-6', harness: 'h', payload: { externalBlockers: [blocker()] } }],
      readPayload: async () => ({ payload: { externalBlockers: [blocker({ status: 'cleared' })] } }),
      writeBlockers: vi.fn(async () => true),
      restoreLifecycle: vi.fn(async () => undefined),
    };
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(out.skipped['lost-race']).toBe(1);
    expect(deps.writeBlockers).not.toHaveBeenCalled();
  });

  it('one failing item does not strand the rest of the batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = fakeDeps({ 'WI-8': { externalBlockers: [blocker()] } });
    const deps: BlockerReapDeps = {
      ...ok.deps,
      listCandidates: async () => [
        { id: 'WI-7', harness: 'h', payload: { externalBlockers: [blocker()] } },
        { id: 'WI-8', harness: 'h', payload: { externalBlockers: [blocker()] } },
      ],
      readPayload: async (id, h) => {
        if (id === 'WI-7') throw new Error('boom');
        return ok.deps.readPayload(id, h);
      },
    };
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(out.skipped['read-failed']).toBe(1);
    expect(out.applied.release_to_agents).toBe(1);
  });
});
