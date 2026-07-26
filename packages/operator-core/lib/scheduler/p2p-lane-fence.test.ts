/**
 * WI-5268 — regression coverage for the durable p2p/federation/rig title-fence
 * helper (p2p-lane-fence.ts). The `backlog-drain` fleet's claim spec has had its
 * hand-authored p2p/federation/rig exclusion regressed TWICE (stripped at rev5,
 * restored at rev6, regressed again at rev9, fixed again at rev10) because the
 * fence lived only as ad hoc glob clauses in the spec JSON with no shared source
 * a test could pin. This file pins `buildP2pLaneFence()`'s CONTENT against
 * representative p2p/federation/rig-titled items — a future edit to
 * `P2P_LANE_EXCLUSION_TERMS` that drops or narrows a term fails a test here
 * instead of silently leaking rig-only work to a single-box fleet member.
 */
import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../work-items';
import type { ClaimSpec } from './claim-spec';
import { matchesWorkItemClaimSpec } from './claim-spec-match';
import { buildP2pLaneFence, P2P_LANE_EXCLUSION_TERMS } from './p2p-lane-fence';

function issueItem(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'title'>): WorkItem {
  return {
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    summary: '',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    severity: 'minor',
    parent: null,
    payload: {},
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  } as WorkItem;
}

function specWithFence(): ClaimSpec {
  return {
    specVersion: '1.0',
    specId: 'p2p-lane-fence-test',
    revision: 1,
    view: { filter: buildP2pLaneFence() },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };
}

describe('WI-5268 — buildP2pLaneFence excludes every representative p2p/federation/rig-titled item', () => {
  const fenced = [
    'p2p offer-store publish leg is flaky',
    'P2P handshake timeout under load',
    'Harden federation swarm re-key handling',
    'Federation capture trigger missing for audit table',
    'VM<->host swarm holepunch fails intermittently',
    'steering lease renewal races the DHT announce',
    'bridge the shared-hive projection gap',
  ];

  it.each(fenced)('excludes: %s', (title) => {
    const item = issueItem({ id: 'WI-x', title });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(false);
  });

  it('does NOT exclude an unrelated item (no over-fencing of the general backlog)', () => {
    const item = issueItem({ id: 'WI-y', title: 'Fix dashboard pagination off-by-one' });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(true);
  });

  it('does not false-positive on a title merely CONTAINING a term inside a larger word (word-boundary correctness, EI-18690730909662985 class)', () => {
    const item = issueItem({
      id: 'WI-z',
      title: "Fleet nonp2p-bug-drain-0725's own claim-spec can't self-claim a meta-bug naming the fleet",
    });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(true); // admitted, not excluded
  });

  it('P2P_LANE_EXCLUSION_TERMS has not silently shrunk (content regression guard — WI-5265/9 class)', () => {
    expect(new Set(P2P_LANE_EXCLUSION_TERMS)).toEqual(
      new Set(['p2p', 'shared-hive', 'federation', 'holepunch', 'steering lease']),
    );
  });

  it('validateClaimSpec accepts a spec built with buildP2pLaneFence()', async () => {
    const { validateClaimSpec } = await import('./claim-spec');
    const v = validateClaimSpec(specWithFence());
    expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  });
});
