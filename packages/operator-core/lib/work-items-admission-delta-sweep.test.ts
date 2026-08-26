import { describe, expect, it } from 'vitest';
import {
  buildDeltaSweepPrompt,
  deltaSweepWatchdogKey,
  parseDeltaSweepProposals,
  type DeltaSweepContext,
} from './work-items-admission-delta-sweep';

const context: DeltaSweepContext = {
  recentItems: [
    {
      id: 'WI-1',
      title: 'CLI freezes after checkout',
      summary: 'The shared runner blocks while resolving the checkout.',
      state: 'open',
      kind: 'bug',
      conditionKey: null,
      admittedAt: '2026-08-26T12:30:00.000Z',
    },
    {
      id: 'WI-2',
      title: 'Deploy queue does not advance',
      summary: 'The release worker waits behind a checkout lock.',
      state: 'open',
      kind: 'bug',
      conditionKey: null,
      admittedAt: '2026-08-26T12:31:00.000Z',
    },
    {
      id: 'WI-3',
      title: 'Workspace sync misses its deadline',
      summary: 'A checkout mutex stays held after the child exits.',
      state: 'open',
      kind: 'bug',
      conditionKey: null,
      admittedAt: '2026-08-26T12:32:00.000Z',
    },
  ],
  last24hTitles: [{ id: 'WI-old', title: 'Earlier lock warning', admittedAt: '2026-08-26T06:00:00.000Z' }],
  sourceCensusRunId: 'census-live',
  clusterShards: [{ shardId: 0, members: 20, ghosts: 3, exemplarTitles: ['WI-old: Earlier lock warning'] }],
};

describe('work-item admission delta sweep', () => {
  it('labels the hourly set as authoritative and keeps historical/cluster context read-only', () => {
    const prompt = buildDeltaSweepPrompt(context, { recentWindowMinutes: 60, titleWindowHours: 24 });
    expect(prompt.system).toContain('SHARED UPSTREAM ROOT-CAUSE BURSTS');
    expect(prompt.system).toContain('Only IDs from CURRENT-WINDOW ITEMS');
    expect(prompt.user).toContain('ONLY valid memberIds');
    expect(prompt.user).toContain('The shared runner blocks while resolving the checkout.');
    expect(prompt.user).toContain('Earlier lock warning');
    expect(prompt.user).toContain('source census census-live');
  });

  it('accepts one five-item root cause but rejects unknown, repeated, or overlapping members', () => {
    const allowed = new Set(['WI-1', 'WI-2', 'WI-3', 'WI-4', 'WI-5', 'WI-6']);
    const proposal = {
      title: 'Orphaned checkout locks stall several pipelines',
      body: 'One unreleased checkout mutex explains all five symptoms.',
      reason: 'Each item names a different consumer waiting on the same lock owner.',
      memberIds: ['WI-5', 'WI-1', 'WI-2', 'WI-3', 'WI-4'],
    };
    expect(parseDeltaSweepProposals({ umbrellas: [proposal] }, allowed)[0]?.memberIds).toEqual([
      'WI-1',
      'WI-2',
      'WI-3',
      'WI-4',
      'WI-5',
    ]);
    expect(() =>
      parseDeltaSweepProposals({ umbrellas: [{ ...proposal, memberIds: ['WI-1', 'WI-2', 'WI-X'] }] }, allowed),
    ).toThrow('non-current member');
    expect(() =>
      parseDeltaSweepProposals({ umbrellas: [{ ...proposal, memberIds: ['WI-1', 'WI-1', 'WI-2'] }] }, allowed),
    ).toThrow('needs 3 distinct members');
    expect(() =>
      parseDeltaSweepProposals(
        {
          umbrellas: [
            { ...proposal, memberIds: ['WI-1', 'WI-2', 'WI-3'] },
            { ...proposal, title: 'A second cause', memberIds: ['WI-3', 'WI-4', 'WI-5'] },
          ],
        },
        allowed,
      ),
    ).toThrow('multiple umbrellas');
  });

  it('derives a stable exact identity from normalized title text', () => {
    expect(deltaSweepWatchdogKey('papercusp', 'Checkout lock leaked!')).toBe(
      deltaSweepWatchdogKey('papercusp', ' checkout  LOCK--leaked '),
    );
    expect(deltaSweepWatchdogKey('papercusp', 'Checkout lock leaked')).not.toBe(
      deltaSweepWatchdogKey('other', 'Checkout lock leaked'),
    );
  });
});
