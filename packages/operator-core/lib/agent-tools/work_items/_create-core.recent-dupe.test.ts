/**
 * _create-core.recent-dupe.test — EI-9940's recent-lexical-dupe-guard wire-in
 * contract on createOneWorkItem: NEVER blocks (advisory-only, unlike the P-008
 * hard band); merges into `similarOpen` alongside anything the semantic guard
 * already found, deduped by id; skipped entirely under force:true; a null
 * verdict (fail-open) leaves similarOpen untouched. The guard's own scoring
 * logic is covered by recent-lexical-dupe-guard.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));
vi.mock('./mirror-guard', () => ({ findMirroredOpenItem: vi.fn(async () => null) }));
vi.mock('../_hive-scope', () => ({
  resolveHiveScope: vi.fn(async () => ({ kind: 'hive', slug: 'papercusp' })),
  HIVE_REQUIRED_DETAIL: 'hive required',
}));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: {} }) }));
vi.mock('../../datatype-registry-store', () => ({ getGenericKindDatatype: vi.fn(async () => null) }));
vi.mock('../../datatype-payload-validation', () => ({ validateDatatypePayload: () => ({ ok: true as const }) }));
vi.mock('../../routing-gate-hints', () => ({ matchRoutingGateHint: () => null }));
vi.mock('../../issue-blocks-merge', () => ({ planItemRef: (s: string, i: string) => `${s}#${i}`, PLAN_ITEM_KIND: 'plan_item' }));
vi.mock('./semantic-dupe-guard', () => ({ findSemanticDupes: vi.fn(async () => null) }));
vi.mock('./recent-lexical-dupe-guard', () => ({ findRecentLexicalDupes: vi.fn(async () => null) }));

import { createOneWorkItem } from './_create-core';
import { findSemanticDupes } from './semantic-dupe-guard';
import { findRecentLexicalDupes } from './recent-lexical-dupe-guard';
import type { SemanticDupeCandidate } from './semantic-dupe-guard';

const semanticM = vi.mocked(findSemanticDupes);
const recentM = vi.mocked(findRecentLexicalDupes);
const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

const recentCand = (id: string, similarity = 0.6): SemanticDupeCandidate => ({
  id,
  title: `recent dupe ${id}`,
  state: 'open',
  harness: 'papercusp',
  similarity,
  source: 'lexical-recent',
});

beforeEach(() => {
  semanticM.mockReset();
  recentM.mockReset();
  semanticM.mockResolvedValue(null);
  recentM.mockResolvedValue([]);
});

describe('createOneWorkItem × recent-lexical dupe guard (EI-9940)', () => {
  it('NEVER blocks — a recent lexical match still creates the item (advisory only)', async () => {
    recentM.mockResolvedValue([recentCand('WI-4241')]);
    const r = await createOneWorkItem({ kind: 'bug', title: 'a fresh near-duplicate title' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.workItem.id).toBe('WI-NEW');
    expect(r.similarOpen?.map((c) => c.id)).toEqual(['WI-4241']);
    expect(r.similarOpen?.[0].source).toBe('lexical-recent');
  });

  it('merges with the semantic guard\'s soft matches, deduped by id', async () => {
    semanticM.mockResolvedValue({
      hard: [],
      soft: [{ id: 'WI-10', title: 'semantic soft dupe', state: 'todo', harness: 'papercusp', similarity: 0.87 }],
      thresholds: { hard: 0.93, soft: 0.85 },
    });
    // WI-10 also shows up in the recent-lexical pass (same id) — must not duplicate;
    // WI-11 is a genuinely new recent-only match and must be appended.
    recentM.mockResolvedValue([recentCand('WI-10'), recentCand('WI-11')]);
    const r = await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.similarOpen?.map((c) => c.id)).toEqual(['WI-10', 'WI-11']);
    // The original semantic candidate (no `source` tag) must survive un-clobbered.
    expect(r.similarOpen?.[0].source).toBeUndefined();
  });

  it('force:true skips the recent-lexical prescreen entirely too', async () => {
    recentM.mockResolvedValue([recentCand('WI-9')]);
    const r = await createOneWorkItem({ kind: 'bug', title: 't', force: true }, ctx);
    expect(r.ok).toBe(true);
    expect(recentM).not.toHaveBeenCalled();
  });

  it('null verdict (fail-open) leaves similarOpen untouched (no advisory key)', async () => {
    recentM.mockResolvedValue(null);
    const r = await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect('similarOpen' in r).toBe(false);
  });

  it('passes the resolved harness through (args.harness ?? ctx.harnessSlug)', async () => {
    await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(recentM).toHaveBeenCalledWith({ title: 't', harness: 'papercusp' });
  });
});
