/**
 * Regression coverage for WI-5272: the backlog-drain p2p/federation/rig title-glob
 * fence over-fired on unrelated subsystems whose title/file-path merely CONTAINS the
 * word "federation" (WI-5184/WI-5270 — a de-quarantine item naming
 * lib/memory/federation-slug-stamp.integration.test.ts). Two things are pinned here:
 *
 *  1. `claimSpecSubjectFromWorkItem` folds the singular `payload.filePath` (the
 *     testing:flakiness quarantine-family convention) into the plural `paths` array
 *     the spec DSL's `paths` field already reads — without this, a de-quarantine
 *     item carries NO structural (non-title) signal a spec filter can use.
 *  2. A hardened filter tree — the title-glob exclusion ANDed with a NOT of a
 *     known-safe path carve-out — correctly discriminates the false-positive class
 *     from a genuine p2p/federation/rig item, per WI-5272's stated acceptance:
 *     (a) a real p2p/federation/rig item stays fenced, (b) an unrelated item whose
 *     title/path merely mentions the word does NOT get excluded.
 */
import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../work-items';
import type { ClaimSpec, FilterNode } from './claim-spec';
import { positiveIdCohortIds, validateClaimSpec } from './claim-spec';
import { claimSpecSubjectFromWorkItem, matchesClaimSpecFilter, matchesWorkItemClaimSpec } from './claim-spec-match';

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

/** The live backlog-drain-clean title-glob terms (rev11), verbatim. */
const P2P_TITLE_GLOBS = ['*p2p*', '*P2P*', '*teering lease*', '*hared-hive*', '*federation*', '*Federation*', '*holepunch*'];

/** WI-5272's proposed durable replacement: exclude on the title glob UNLESS the
 *  item's `paths` positively show a known-safe, non-p2p directory (currently just
 *  the proven lib/memory/** false-positive case — extend as new classes surface). */
const HARDENED_FENCE: FilterNode = {
  not: {
    all: [
      { any: P2P_TITLE_GLOBS.map((value) => ({ field: 'title', op: 'glob', value }) as const) },
      // Leading `*` matters: globRegex anchors `^...$` with no implicit path-prefix
      // matching, and real paths.paths entries are repo-relative from the monorepo
      // root (e.g. `packages/operator-core/lib/memory/...`), not bare `lib/memory/...`.
      { not: { any: [{ field: 'paths', op: 'glob', value: '*lib/memory/**' }] } },
    ],
  },
};

describe('claimSpecSubjectFromWorkItem folds payload.filePath into paths (WI-5272)', () => {
  it('surfaces the quarantine-family payload.filePath convention as a paths entry', () => {
    const subject = claimSpecSubjectFromWorkItem(
      issueItem({
        id: 'WI-5270',
        title: 'De-quarantine follow-up: lib/memory/federation-slug-stamp.integration.test.ts flake',
        payload: { filePath: 'packages/operator-core/lib/memory/federation-slug-stamp.integration.test.ts' },
      }),
    );
    expect(subject.paths).toEqual(['packages/operator-core/lib/memory/federation-slug-stamp.integration.test.ts']);
  });

  it('dedupes against an already-populated payload.paths instead of appending a duplicate', () => {
    const subject = claimSpecSubjectFromWorkItem(
      issueItem({
        id: 'WI-x',
        title: 'x',
        payload: { paths: ['a/b.ts'], filePath: 'a/b.ts' },
      }),
    );
    expect(subject.paths).toEqual(['a/b.ts']);
  });

  it('leaves paths empty when neither payload.paths nor payload.filePath is set (today\'s WI-5270 shape)', () => {
    const subject = claimSpecSubjectFromWorkItem(issueItem({ id: 'WI-5270', title: 'x', payload: {} }));
    expect(subject.paths).toEqual([]);
  });
});

describe('WI-5272 hardened p2p/federation/rig fence — false-positive vs real-leak', () => {
  it('still fences a genuine federation/p2p item that carries no path evidence (no WI-5265 regression)', () => {
    const item = issueItem({ id: 'EI-636', title: 'p2p-perf regression: merge.delta-tick deltaTick1000Ms worse' });
    expect(matchesWorkItemClaimSpec(item, {
      specVersion: '1.0',
      specId: 't',
      revision: 1,
      view: { filter: HARDENED_FENCE },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    })).toBe(false);
  });

  it('still fences a genuine federation item whose paths ARE under a p2p-domain directory', () => {
    const item = issueItem({
      id: 'WI-x',
      title: 'Harden federation swarm re-key handling',
      payload: { paths: ['packages/operator-core/lib/sync/hyperbee/swarm.ts'] },
    });
    expect(matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(item), HARDENED_FENCE)).toBe(false);
  });

  it('admits the WI-5184/WI-5270 false-positive once filePath is folded into paths', () => {
    const item = issueItem({
      id: 'WI-5270',
      title: 'De-quarantine follow-up: lib/memory/federation-slug-stamp.integration.test.ts flake (flipRate 0.625)',
      payload: { filePath: 'packages/operator-core/lib/memory/federation-slug-stamp.integration.test.ts' },
    });
    expect(matchesWorkItemClaimSpec(item, {
      specVersion: '1.0',
      specId: 't',
      revision: 1,
      view: { filter: HARDENED_FENCE },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    })).toBe(true);
  });

  it('WITHOUT the fold-in fix, the same item stays wrongly fenced (documents the bug the fix closes)', () => {
    // Simulate the pre-fix mapping by asserting directly against a subject built
    // from payload.paths alone (filePath ignored) — the shape claimSpecSubjectFromWorkItem
    // produced before this change.
    const preFixSubject = {
      id: 'WI-5270',
      title: 'De-quarantine follow-up: lib/memory/federation-slug-stamp.integration.test.ts flake',
      kind: 'change',
      priority: null,
      tags: [],
      paths: [], // payload.filePath was NOT read pre-fix
      plan: null,
      planItem: [],
      age: 0,
      riskTier: null,
      redundancy: null,
      estCost: null,
      assignee: null,
    };
    expect(matchesClaimSpecFilter(preFixSubject, HARDENED_FENCE)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EI-14231 — a `not:{id in [...]}` exclusion inside an otherwise wide-open drain
// spec must not starve the fleet. This is the exact `backlog-drain-clean@6` live
// incident (2026-07-17): a leader excluded two already-handled ids (WI-5245/WI-5246)
// via `{ not: { field:'id', op:'in', value:[...] } }`, and scheduler:get_next then
// returned ZERO on every call for 7+ hours while hundreds of open bug/change/task
// items sat unclaimed — because the OLD tier-3 gate (the since-removed
// filterHasIdConstraint) saw the `not`-wrapped id leaf, mis-read it as "the spec
// names an explicit id allowlist", and SKIPPED tier 3 (the only path that serves
// issue-family work) entirely. The durable fix has three legs:
//   1. positiveIdCohortIds returns null for a `not`-wrapped id leaf (a negation is
//      NOT a closed-world allowlist), so tier 3 now RUNS unrestricted-by-id
//      (claim-spec.ts; pinned in claim-spec.test.ts);
//   2. negativeIdExclusions threads the excluded ids into tier 3's SQL excludeIds
//      so the exclusion is HONORED (get-next.ts; the SQL leg pinned end-to-end in
//      get-next.integration.test.ts's "NOT-wrapped id EXCLUSION" case);
//   3. getNextForBee's mandatory post-claim `matchesWorkItemClaimSpec` re-check
//      against the FULL filter tree — the SQL narrowing only handles kind/id, so
//      this JS re-check is the safety net that guarantees a `not:{id in}` (and the
//      title-globs the SQL never narrows by) are actually applied before a claim
//      stands (a mismatch releases + retries).
//
// The integration test covers a MINIMAL shape (`all:[kind in [bug], not:{id in}]`).
// This unit block pins the FULL incident composition — the 4-kind list (feature
// included), several `not:{title glob}` fences, AND the `not:{id in}` exclusion all
// ANDed together — against leg 3's evaluator, WITHOUT Postgres: it (a) validates
// (the trap's signature is that it validates then mis-executes) and (b) admits a
// normal open bug while excluding both an excluded-id item and a p2p-titled one.
// ────────────────────────────────────────────────────────────────────────────
describe('EI-14231 — a not:{id in [...]} exclusion in a wide drain spec never starves the lane', () => {
  const EXCLUDED_IDS = ['WI-5245', 'WI-5246'];
  /** The `backlog-drain-clean` fleet's live spec shape (rev 8): 4-kind drain, several
   *  title-glob fences, plus the two-id exclusion that triggered the incident. */
  const DRAIN_FILTER: FilterNode = {
    all: [
      { field: 'kind', op: 'in', value: ['bug', 'change', 'task', 'feature'] },
      { not: { field: 'title', op: 'glob', value: '*p2p*' } },
      { not: { field: 'title', op: 'glob', value: '*federation*' } },
      { not: { field: 'title', op: 'glob', value: '*hared-hive*' } },
      { not: { field: 'title', op: 'glob', value: '*holepunch*' } },
      { not: { field: 'id', op: 'in', value: EXCLUDED_IDS } },
    ],
  };
  const drainSpec: ClaimSpec = {
    specVersion: '1.0',
    specId: 'backlog-drain-clean',
    revision: 8,
    view: { filter: DRAIN_FILTER },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    states: ['todo', 'open', 'failing'],
  };

  it('the incident spec VALIDATES (the trap is that it validates, then mis-executed)', () => {
    const v = validateClaimSpec(drainSpec);
    expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  });

  it('positiveIdCohortIds is null for the `not:{id in}` shape — so tier 3 runs unrestricted-by-id (the fix)', () => {
    // If this ever regressed to returning a non-null set, the ladder would land on the
    // "spec names an id allowlist" branch again and starve the whole issue lane.
    expect(positiveIdCohortIds(DRAIN_FILTER)).toBeNull();
  });

  it('ADMITS a normal open bug that is neither excluded nor p2p-titled (the item wrongly starved for 7h)', () => {
    const item = issueItem({ id: 'WI-5174', title: 'Fix dashboard pagination off-by-one', kind: 'bug' });
    expect(matchesWorkItemClaimSpec(item, drainSpec)).toBe(true);
  });

  it('EXCLUDES an item whose id is in the not:{id in} set — the exclusion is honored, not ignored', () => {
    for (const id of EXCLUDED_IDS) {
      const item = issueItem({ id, title: 'GO-gate scratch item', kind: 'change' });
      expect(matchesWorkItemClaimSpec(item, drainSpec), `${id} must be excluded`).toBe(false);
    }
  });

  it('still EXCLUDES a p2p-titled item — the exclusion fix did not widen the title fences into no-ops', () => {
    const item = issueItem({ id: 'WI-9001', title: 'p2p offer-store publish leg', kind: 'bug' });
    expect(matchesWorkItemClaimSpec(item, drainSpec)).toBe(false);
  });

  it('the evaluator and positiveIdCohortIds agree the lane is non-empty: a non-excluded issue is admissible', () => {
    // The whole point: the spec matches a healthy set of rows (here, one representative),
    // so a get_next miss under it would be a real bug, not "the queue is empty".
    const admissible = [
      issueItem({ id: 'WI-5174', title: 'Fix pagination', kind: 'bug' }),
      issueItem({ id: 'EI-8100', title: 'Tidy the scheduler diagnosis block', kind: 'change' }),
      issueItem({ id: 'WI-7000', title: 'Add a task-runner retry cap', kind: 'task' }),
    ].filter((it) => matchesWorkItemClaimSpec(it, drainSpec));
    expect(admissible.map((it) => it.id)).toEqual(['WI-5174', 'EI-8100', 'WI-7000']);
  });
});
