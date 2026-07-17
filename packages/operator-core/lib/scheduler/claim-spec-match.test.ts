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
import type { FilterNode } from './claim-spec';
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
