/**
 * presence-payload.test.ts — guards for the P-009 two-lane partition
 * (presence-v2-2026-06-14 / D-005 / D-006).
 *
 * Asserts: (1) the partition classifies fields into the right lane for local +
 * federated rows; (2) the byte-stable invariant — identity+state of an
 * unchanged agent serialize byte-identically across two reads (only the
 * liveness scalar moves); (3) the drift guard — every emitted field is
 * classified into exactly one lane (or deliberately dropped), the lanes are
 * pairwise disjoint, and liveness never enters the delta-eligible set; (4) the
 * emitted row drops the raw churning timestamps.
 */
import { describe, it, expect } from 'vitest';
import { mergeTier1, type PresenceTier1Joins } from './presence-tier1';
import type { UnifiedPresenceRecord } from './federated-presence';
import {
  partitionPresenceRow,
  deltaEligibleProjection,
  toStableRosterRow,
  PRESENCE_IDENTITY_FIELDS,
  PRESENCE_STATE_FIELDS,
  PRESENCE_LIVENESS_FIELDS,
  PRESENCE_DROPPED_FIELDS,
  PRESENCE_DELTA_FIELDS,
  type RosterRow,
} from './presence-payload';

/** A maximal row carrying EVERY field the roster can emit — the coverage-guard
 *  fixture. If a new presence field is added, the guard fails until it is added
 *  here AND classified into a lane. */
const MAXIMAL_ROW: RosterRow = {
  // — identity —
  ownerId: 'su-x',
  ownerLabel: 'su · x',
  workspaceId: 'ws',
  source: 'omp-hook-session',
  host: 'box',
  pid: 123,
  startedAt: '2026-06-14T00:00:00.000Z',
  agentRole: 'su',
  hiveSlug: 'papercup-hive',
  model: 'opus',
  userId: 'u1',
  federated: false,
  devicePubkey: 'pk',
  harnessSlug: 'papercup',
  // — state —
  intent: 'doing things',
  currentPlanSlug: 'plan-x',
  currentView: 'harness/papercup',
  currentFiles: ['a.ts'],
  claimedItems: ['P-001'],
  awaitingEvent: true,
  awaitingEventKey: 'k',
  awaitingNote: 'note',
  wakeMode: 'auto',
  revoked: false,
  // — liveness —
  lastActiveSecAgo: 42,
  stale: false,
  // — dropped (raw churning timestamps) —
  heartbeatAt: '2026-06-14T01:00:00.000Z',
  lastActiveAt: '2026-06-14T00:59:00.000Z',
};

/** A local PresenceRecord (pre-enrichment) for the byte-stability pipeline test. */
const LOCAL_BASE: UnifiedPresenceRecord = {
  ownerId: 'su-a',
  ownerLabel: 'su · a',
  workspaceId: 'ws',
  source: 'omp-hook-session',
  intent: 'reviewing the fold',
  currentPlanSlug: 'presence-v2-2026-06-14',
  currentFiles: ['presence.ts'],
  host: 'box',
  pid: 7,
  startedAt: '2026-06-14T00:00:00.000Z',
  heartbeatAt: '2026-06-14T01:00:00.000Z',
  lastActiveAt: '2026-06-14T00:59:00.000Z',
  agentRole: 'su',
  hiveSlug: 'papercup-hive',
  stale: false,
  userId: 'u1',
  revoked: false,
};

const JOINS: PresenceTier1Joins = {
  claimedItems: ['P-009'],
  model: 'opus',
  awaitingEvent: false,
  awaitingEventKey: null,
  awaitingNote: null,
  wakeMode: 'auto',
};

describe('partitionPresenceRow', () => {
  it('classifies a local enriched row into identity / state / liveness', () => {
    const { identity, state, liveness } = partitionPresenceRow(MAXIMAL_ROW);
    expect(identity).toMatchObject({ ownerId: 'su-x', model: 'opus', hiveSlug: 'papercup-hive' });
    expect(state).toMatchObject({ intent: 'doing things', claimedItems: ['P-001'], wakeMode: 'auto' });
    expect(liveness).toEqual({ lastActiveSecAgo: 42, stale: false });
    // raw timestamps live in no lane
    expect(identity).not.toHaveProperty('heartbeatAt');
    expect(state).not.toHaveProperty('lastActiveAt');
  });

  it('omits fields a federated row lacks (no local Tier-1 join)', () => {
    const fed: RosterRow = {
      ownerId: 'fed:42@thinkpad',
      ownerLabel: 'gh:42 · thinkpad',
      workspaceId: 'ws',
      source: 'federated',
      intent: 'remote work',
      currentPlanSlug: null,
      currentFiles: [],
      host: 'thinkpad',
      pid: null,
      startedAt: '2026-06-14T00:00:00.000Z',
      heartbeatAt: '2026-06-14T00:00:00.000Z',
      lastActiveAt: null,
      agentRole: null,
      hiveSlug: 'papercup-hive',
      stale: false,
      userId: '42',
      revoked: false,
      federated: true,
      devicePubkey: 'pk',
      harnessSlug: 'papercup',
      currentView: 'harness/papercup',
      lastActiveSecAgo: null,
    };
    const { identity, state } = partitionPresenceRow(fed);
    expect(identity).toMatchObject({ federated: true, devicePubkey: 'pk', harnessSlug: 'papercup' });
    // federated rows have no local-table joins → these keys are simply absent
    expect(state).not.toHaveProperty('claimedItems');
    expect(identity).not.toHaveProperty('model');
  });
});

describe('byte-stability (D-006)', () => {
  it('identity + state serialize byte-identically across two reads; only liveness moves', () => {
    // Clock must be AFTER the fixture's lastActiveAt or computeLastActiveSecAgo
    // clamps both reads to 0 (≥0 floor) and the "liveness moves" check is moot.
    const now1 = Date.parse('2026-06-14T01:00:00.000Z'); // 60s after lastActiveAt
    const now2 = now1 + 5_000; // +5s of read-time drift
    const [r1] = mergeTier1([LOCAL_BASE], new Map([[LOCAL_BASE.ownerId, JOINS]]), now1);
    const [r2] = mergeTier1([LOCAL_BASE], new Map([[LOCAL_BASE.ownerId, JOINS]]), now2);

    const p1 = partitionPresenceRow(r1);
    const p2 = partitionPresenceRow(r2);

    // The delta-eligible lanes are byte-stable when nothing transitioned.
    expect(JSON.stringify(p1.identity)).toBe(JSON.stringify(p2.identity));
    expect(JSON.stringify(p1.state)).toBe(JSON.stringify(p2.state));
    expect(JSON.stringify(deltaEligibleProjection(r1))).toBe(JSON.stringify(deltaEligibleProjection(r2)));

    // Liveness DOES move with the clock — and is the only thing that does.
    expect(p1.liveness.lastActiveSecAgo).not.toBe(p2.liveness.lastActiveSecAgo);
  });

  it('toStableRosterRow drops the raw timestamps but keeps the derived scalar', () => {
    const [row] = mergeTier1([LOCAL_BASE], new Map([[LOCAL_BASE.ownerId, JOINS]]), 1_700_000_000_000);
    const emitted = toStableRosterRow(row);
    expect(emitted).not.toHaveProperty('heartbeatAt');
    expect(emitted).not.toHaveProperty('lastActiveAt');
    expect(emitted).not.toHaveProperty('stale'); // conveyed by the active/stale array split
    expect(emitted).toHaveProperty('ownerId', 'su-a');
    expect(emitted).toHaveProperty('startedAt'); // stable identity timestamp — kept
    expect(emitted).toHaveProperty('lastActiveSecAgo');
  });
});

describe('two-lane drift guard (D-005)', () => {
  const overlap = (a: readonly string[], b: readonly string[]) => a.filter((x) => b.includes(x));

  it('every emitted field is classified into exactly one lane (or deliberately dropped)', () => {
    const classified = [
      ...PRESENCE_IDENTITY_FIELDS,
      ...PRESENCE_STATE_FIELDS,
      ...PRESENCE_LIVENESS_FIELDS,
      ...PRESENCE_DROPPED_FIELDS,
    ] as readonly string[];
    const emittedKeys = Object.keys(MAXIMAL_ROW);
    // Exact set equality, both directions: a new field forces classification,
    // and a typo'd field-set entry that can't appear is also caught.
    expect(emittedKeys.filter((k) => !classified.includes(k))).toEqual([]);
    expect(classified.filter((k) => !emittedKeys.includes(k))).toEqual([]);
  });

  it('the lanes are pairwise disjoint', () => {
    expect(overlap(PRESENCE_IDENTITY_FIELDS, PRESENCE_STATE_FIELDS)).toEqual([]);
    expect(overlap(PRESENCE_IDENTITY_FIELDS, PRESENCE_LIVENESS_FIELDS)).toEqual([]);
    expect(overlap(PRESENCE_STATE_FIELDS, PRESENCE_LIVENESS_FIELDS)).toEqual([]);
    expect(overlap(PRESENCE_DROPPED_FIELDS, [...PRESENCE_IDENTITY_FIELDS, ...PRESENCE_STATE_FIELDS, ...PRESENCE_LIVENESS_FIELDS])).toEqual([]);
  });

  it('liveness is never delta-eligible (the notify-storm guard)', () => {
    expect(overlap(PRESENCE_LIVENESS_FIELDS, PRESENCE_DELTA_FIELDS)).toEqual([]);
    // delta-eligible IS exactly identity ∪ state
    expect([...PRESENCE_DELTA_FIELDS].sort()).toEqual(
      [...PRESENCE_IDENTITY_FIELDS, ...PRESENCE_STATE_FIELDS].sort(),
    );
  });
});
