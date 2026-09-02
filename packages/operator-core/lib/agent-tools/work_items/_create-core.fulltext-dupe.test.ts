/**
 * _create-core.fulltext-dupe.test — EI-19298062354262754's fulltext-lexical-dupe-guard
 * wire-in contract on createOneWorkItem: NEVER blocks (advisory-only, like the
 * recent-lexical guard); merges into the candidate set alongside anything the other
 * guards already found, deduped by id; skipped entirely under force:true; a null
 * verdict (fail-open) leaves the set untouched. The guard's own
 * scoring logic is covered by fulltext-lexical-dupe-guard.test.ts.
 *
 * The merged set is observed at `persistDedupEdges` — where a SUCCESSFUL create now
 * sends it (work-queue-admission-and-bulk-dedup P-002, item d) instead of returning
 * `similarOpen` to the filing agent. That writer is mocked here, so this file sees the
 * full merged set; its own cosine-only filter is dedup-edges.ts's contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dedupEdgeMocks = vi.hoisted(() => ({
  persist: vi.fn(async (input: { candidates?: readonly { id: string }[] }) => input.candidates?.length ?? 0),
}));
vi.mock('./dedup-edges', () => ({ persistDedupEdges: dedupEdgeMocks.persist }));

/** The candidate set the last successful create handed to the promoter's substrate. */
const persistedCandidates = (): readonly { id: string; source?: string }[] | undefined =>
  dedupEdgeMocks.persist.mock.calls.at(-1)?.[0].candidates as
    | readonly { id: string; source?: string }[]
    | undefined;

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
vi.mock('../../work-items', () => ({
  createWorkItem: vi.fn(async (input: { kind: string; title: string }) => ({
    id: 'WI-NEW',
    kind: input.kind,
    title: input.title,
  })),
  getWorkItem: vi.fn(async () => null),
  linkWorkItem: vi.fn(async () => {}),
  isWorkItemKind: (k: string) => ['feature', 'chunk', 'bug', 'change', 'task'].includes(k),
  isDeprecatedWorkItemKind: (k: string) => k === 'chunk',
  familyOf: (k: string) => (['bug', 'change', 'task'].includes(k) ? 'issue' : 'feature'),
  ensureClaimHoldAttribution: (payload: unknown) => payload,
}));
vi.mock('./mirror-guard', () => ({ findMirroredOpenItem: vi.fn(async () => null) }));
vi.mock('../_pot-scope', () => ({
  resolvePotScope: vi.fn(async () => ({ kind: 'pot', slug: 'papercusp' })),
  POT_REQUIRED_DETAIL: 'hive required',
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} }) }));
vi.mock('../../datatype-registry-store', () => ({ getGenericKindDatatype: vi.fn(async () => null) }));
vi.mock('../../datatype-payload-validation', () => ({ validateDatatypePayload: () => ({ ok: true as const }) }));
vi.mock('../../routing-gate-hints', () => ({ matchRoutingGateHint: () => null }));
vi.mock('../../issue-blocks-merge', () => ({ planItemRef: (s: string, i: string) => `${s}#${i}`, PLAN_ITEM_KIND: 'plan_item' }));
vi.mock('./semantic-dupe-guard', () => ({ findSemanticDupes: vi.fn(async () => null) }));
vi.mock('./recent-lexical-dupe-guard', () => ({ findRecentLexicalDupes: vi.fn(async () => null) }));
vi.mock('./fulltext-lexical-dupe-guard', () => ({ findFulltextLexicalDupes: vi.fn(async () => null) }));

// EI-21872682653374832 — createOneWorkItem stamps goal provenance (_create-core.ts:1198).
// Unmocked, resolveGoalContext reaches the real authority read, which fails CLOSED with
// `goal_holder_authority_unreadable` (goal-context.ts:54) because no fixture can supply that
// authority. The stamp's catch console.warns by design (EI-20075667133396690) and
// vitest-fail-on-console turns that warn into a failure BEFORE these tests reach their own
// assertions. null is the honest fixture answer: this agent runs under no goal, which is the
// majority production path. Do NOT silence the production warn instead — the warn is the feature.
vi.mock('../../modes/goal-context', () => ({
  resolveGoalContext: vi.fn(async () => null),
}));

import { createOneWorkItem } from './_create-core';
import { findSemanticDupes } from './semantic-dupe-guard';
import { findFulltextLexicalDupes } from './fulltext-lexical-dupe-guard';
import type { SemanticDupeCandidate } from './semantic-dupe-guard';

const semanticM = vi.mocked(findSemanticDupes);
const fulltextM = vi.mocked(findFulltextLexicalDupes);
const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

const fulltextCand = (id: string, similarity = 0.7): SemanticDupeCandidate => ({
  id,
  title: `fulltext dupe ${id}`,
  state: 'open',
  harness: 'papercusp',
  similarity,
  source: 'lexical-fulltext',
});

beforeEach(() => {
  semanticM.mockReset();
  fulltextM.mockReset();
  dedupEdgeMocks.persist.mockClear();
  semanticM.mockResolvedValue(null);
  fulltextM.mockResolvedValue([]);
});

describe('createOneWorkItem × fulltext-lexical dupe guard (EI-19298062354262754)', () => {
  it('NEVER blocks — a fulltext match still creates the item (advisory only)', async () => {
    fulltextM.mockResolvedValue([fulltextCand('EI-100')]);
    const r = await createOneWorkItem({ kind: 'bug', title: 'a paraphrased refile' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.workItem.id).toBe('WI-NEW');
    expect('similarOpen' in r).toBe(false);
    expect(persistedCandidates()?.map((c) => c.id)).toEqual(['EI-100']);
    expect(persistedCandidates()?.[0].source).toBe('lexical-fulltext');
  });

  it("merges with the semantic guard's soft matches, deduped by id", async () => {
    semanticM.mockResolvedValue({
      hard: [],
      soft: [{ id: 'WI-10', title: 'semantic soft dupe', state: 'todo', harness: 'papercusp', similarity: 0.87 }],
      thresholds: { hard: 0.93, soft: 0.85 },
    });
    // WI-10 also shows up in the fulltext pass (same id) — must not duplicate;
    // EI-11 is a genuinely new fulltext-only match and must be appended.
    fulltextM.mockResolvedValue([fulltextCand('WI-10'), fulltextCand('EI-11')]);
    const r = await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(persistedCandidates()?.map((c) => c.id)).toEqual(['WI-10', 'EI-11']);
    expect(persistedCandidates()?.[0].source).toBeUndefined();
  });

  it('force:true skips the fulltext prescreen entirely too', async () => {
    fulltextM.mockResolvedValue([fulltextCand('EI-9')]);
    const r = await createOneWorkItem({ kind: 'bug', title: 't', force: true }, ctx);
    expect(r.ok).toBe(true);
    expect(fulltextM).not.toHaveBeenCalled();
  });

  it('null verdict (fail-open) leaves the candidate set untouched — nothing to persist', async () => {
    fulltextM.mockResolvedValue(null);
    const r = await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect('similarOpen' in r).toBe(false);
    expect(persistedCandidates()).toBeUndefined();
  });

  it('runs for every issue-family kind (bug, change, task)', async () => {
    for (const kind of ['bug', 'change', 'task']) {
      fulltextM.mockClear();
      await createOneWorkItem({ kind, title: 't' }, ctx);
      expect(fulltextM).toHaveBeenCalledTimes(1);
    }
  });

  it('is SKIPPED for feature-family kinds (feature, chunk) — engineer_issues has no rows for them', async () => {
    fulltextM.mockClear();
    await createOneWorkItem({ kind: 'feature', title: 't', harness: 'papercusp' }, ctx);
    expect(fulltextM).not.toHaveBeenCalled();
  });

  it('passes title and summary through for summary-aware unified dedup', async () => {
    await createOneWorkItem({ kind: 'bug', title: 't', summary: 'body words' }, ctx);
    expect(fulltextM).toHaveBeenCalledWith({ title: 't', summary: 'body words' });
  });
});
