import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ loop: vi.fn(), carry: vi.fn() }));
vi.mock('./harness/routines/loop', () => ({ getLoopStatus: mocks.loop }));
vi.mock('./carry-note', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./carry-note')>()),
  getLoopCarryNoteWithMeta: mocks.carry,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: async () => [] }),
}));
vi.mock('./workspace-registry', () => ({ resolveConcreteWorkspaceId: (ws: string) => ws }));

import { renderCarryNote, type CheckEntry } from './carry-note';
import type { ContinuityProbe } from './continuity-probes';
import {
  composeOrientationBlock, defaultOrientationDeps, fingerprintOrientation,
  type OrientationOpenCheck, type OrientationState,
} from './turn-start-orientation';

const probes: ContinuityProbe[] = [
  { kind: 'tool', tool: 'work_items:get', args: { id: 'WI-123', resume: true },
    schemaRevision: 'revision-1', expect: { path: '$.state', op: 'eq', value: 'open' } },
  { kind: 'state-cell', cell: 'governor.health', schemaRevision: 'revision-1',
    expect: { path: '$.status', op: 'eq', value: 'healthy' } },
  { kind: 'sql', sql: 'SELECT 1 AS n', maxRows: 1, schemaRevision: 'revision-1',
    expect: { path: '$.rows[0].n', op: 'eq', value: 1 } },
];

function state(openChecks: OrientationOpenCheck[]): OrientationState {
  return {
    planDecisions: undefined, lockTransitions: undefined, coupledPeers: [], held: [],
    historyUpdates: [], effortUpdates: [], unansweredDirected: 0, unansweredStale: 0,
    openAsks: null, inboxRecent: [], announcedGates: [], modes: [], authorityVerdict: null,
    loopArmed: true, loopFireWithheld: false, improvementTriage: null, executableFrontier: null,
    neverDropFacts: [], toolSurface: null, carryBlindWindow: null, openChecks,
  };
}

async function project(checks: CheckEntry[]) {
  mocks.carry.mockResolvedValue({ note: renderCarryNote({ did: 'Probe regression', checks }), readFailed: false });
  return defaultOrientationDeps().openChecks('su-probes', 'ws-probes');
}

describe('turn-start stored continuity probes (EI-28952378159249249)', () => {
  beforeEach(() => {
    mocks.loop.mockResolvedValue({ active: true, harnessSlug: 'papercusp' });
    mocks.carry.mockReset();
  });

  it.each(probes)('projects and renders a stored $kind probe without legacy recheck text', async (probe) => {
    const rows = await project([{ id: 'typed-only', claim: 'item remains open', probe }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].probe).toEqual(probe);
    expect(rows[0].pointer).toBe('loop:status');
    const block = composeOrientationBlock({ state: state(rows), committed: null, epoch: 1 });
    expect(block).toContain(`stored ${probe.kind} probe`);
    expect(block).toContain('via loop:status');
    expect(block).toContain('? UNVERIFIED');
    expect(block).not.toContain('NO PROBE STORED');
  });

  it('keeps legacy rechecks and accurately identifies rows with no probe', async () => {
    const rows = await project([
      { id: 'legacy', claim: 'legacy claim', recheck: 'read the existing record' },
      { id: 'missing', claim: 'missing probe claim' },
    ]);
    const block = composeOrientationBlock({ state: state(rows), committed: null, epoch: 1 });
    expect(block).toContain('run recheck: read the existing record');
    expect(block).toContain('NO PROBE STORED');
  });

  it('retains both probe forms when a row also carries human guidance', async () => {
    const rows = await project([{ id: 'both', claim: 'open item', probe: probes[0], recheck: 'explain the replay' }]);
    expect(rows[0]).toMatchObject({ probe: probes[0], recheck: 'explain the replay' });
  });

  it('keeps contested claims ahead of unverified claims and excludes settled claims', async () => {
    const rows = await project([
      { id: 'settled', claim: 'settled claim', probe: probes[0], verified: 'confirmed from current record' },
      { id: 'pending', claim: 'pending claim', probe: probes[1] },
      { id: 'contested', claim: 'contested claim', probe: probes[2], contested: 'record contradicts the claim' },
    ]);
    expect(rows.map(row => row.claim)).toEqual(['pending claim', 'contested claim']);
    const block = composeOrientationBlock({ state: state(rows), committed: null, epoch: 1 });
    expect(block.indexOf('CONTESTED')).toBeLessThan(block.indexOf('UNVERIFIED'));
    expect(block).not.toContain('settled claim');
    expect(block).not.toContain('NO PROBE STORED');
  });

  it.each(probes)('re-delivers a stable row when a $kind probe is added or revised', (probe) => {
    const row: OrientationOpenCheck = { id: 'stable', claim: 'unchanged claim', kind: 'check', pointer: 'loop:status' };
    const initial = fingerprintOrientation(state([row]), 1);
    const added = state([{ ...row, probe }]);
    expect(fingerprintOrientation(added, 1).openChecks).not.toBe(initial.openChecks);
    expect(composeOrientationBlock({ state: added, committed: initial, epoch: 1 })).toContain(`stored ${probe.kind} probe`);
    const revised = state([{ ...row, probe: { ...probe, schemaRevision: 'revision-2' } }]);
    expect(fingerprintOrientation(revised, 1).openChecks).not.toBe(fingerprintOrientation(added, 1).openChecks);
    expect(composeOrientationBlock({ state: revised, committed: fingerprintOrientation(added, 1), epoch: 1 })).toContain('complete probe');
  });
});
