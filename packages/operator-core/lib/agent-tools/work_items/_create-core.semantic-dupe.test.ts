/**
 * _create-core.semantic-dupe.test — the P-008 prescreen's wire-in contract on
 * createOneWorkItem: a hard cosine match refuses with `duplicate_semantic` +
 * the matched OPEN items; force:true skips the prescreen entirely; a soft
 * match creates WITH the `similarOpen` advisory; a null verdict (guard
 * fail-open) creates cleanly with no advisory key. The guard itself is
 * mocked — its internals are covered by semantic-dupe-guard.test.ts. The
 * EI-9940 recent-lexical-dupe-guard sibling check is likewise mocked here
 * (fail-open by default) — its own wire-in + merge-with-similarOpen contract
 * is covered by _create-core.recent-dupe.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const occurrenceMocks = vi.hoisted(() => ({
  record: vi.fn(async () => null),
}));

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
  familyOf: (k: string) => (['bug', 'change', 'task'].includes(k) ? 'issue' : 'feature'),
  ensureClaimHoldAttribution: (payload: unknown) => payload,
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
vi.mock('./fulltext-lexical-dupe-guard', () => ({ findFulltextLexicalDupes: vi.fn(async () => null) }));
vi.mock('../../issue-occurrence-ledger', async () => {
  const actual = await vi.importActual<typeof import('../../issue-occurrence-ledger')>(
    '../../issue-occurrence-ledger',
  );
  return { ...actual, recordIssueOccurrence: occurrenceMocks.record };
});

import { createOneWorkItem } from './_create-core';
import { findSemanticDupes, type SemanticDupeResult } from './semantic-dupe-guard';
import { findFulltextLexicalDupes } from './fulltext-lexical-dupe-guard';
import { createWorkItem } from '../../work-items';

const guardM = vi.mocked(findSemanticDupes);
const fulltextM = vi.mocked(findFulltextLexicalDupes);
const createM = vi.mocked(createWorkItem);
const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

const verdict = (hard: number[], soft: number[]): SemanticDupeResult => ({
  hard: hard.map((s, i) => ({ id: `EI-${i + 1}`, title: `open dupe ${i + 1}`, state: 'open', harness: 'papercusp', similarity: s })),
  soft: soft.map((s, i) => ({ id: `WI-${i + 10}`, title: `near ${i}`, state: 'todo', harness: 'papercusp', similarity: s })),
  thresholds: { hard: 0.93, soft: 0.85 },
});

beforeEach(() => {
  guardM.mockReset();
  guardM.mockResolvedValue(null);
  fulltextM.mockReset();
  fulltextM.mockResolvedValue([]);
  createM.mockClear();
  occurrenceMocks.record.mockClear();
});

describe('createOneWorkItem × semantic dupe prescreen (P-008)', () => {
  it('hard match refuses with duplicate_semantic + existing + similarOpen', async () => {
    guardM.mockResolvedValue(verdict([0.96], []));
    const r = await createOneWorkItem({ kind: 'bug', title: 'agents keep filing the same bug' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('duplicate_semantic');
    expect(r.existing).toEqual({ id: 'EI-1', state: 'open' });
    expect(r.similarOpen?.map((c) => c.id)).toEqual(['EI-1']);
    expect(r.message).toContain('EI-1');
    expect(r.message).toContain('force:true');
    expect(occurrenceMocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: 'EI-1',
        canonicalHarness: 'papercusp',
        reporter: 'me',
        sourceTool: 'work_items:create',
        reportKind: 'duplicate',
        reportedTitle: 'agents keep filing the same bug',
        admissionIdentity: expect.objectContaining({ schemaVersion: 'admission-identity-v1' }),
      }),
    );
  });

  it('force:true skips the prescreen entirely (mirrors the EI-316 override contract)', async () => {
    guardM.mockResolvedValue(verdict([0.99], []));
    const r = await createOneWorkItem({ kind: 'bug', title: 't', force: true }, ctx);
    expect(r.ok).toBe(true);
    expect(guardM).not.toHaveBeenCalled();
  });

  it('soft match creates WITH the similarOpen advisory', async () => {
    guardM.mockResolvedValue(verdict([], [0.88, 0.86]));
    const r = await createOneWorkItem({ kind: 'bug', title: 't', summary: 's' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.workItem.id).toBe('WI-NEW');
    expect(r.similarOpen?.map((c) => c.id)).toEqual(['WI-10', 'WI-11']);
    // The guard saw the item's own harness fallback (args.harness ?? ctx.harnessSlug).
    expect(guardM).toHaveBeenCalledWith({ title: 't', summary: 's', harness: 'papercusp' });
  });

  it('null verdict (guard fail-open) creates cleanly with no advisory key', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: 't', summary: 'fresh evidence' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect('similarOpen' in r).toBe(false);
    expect(occurrenceMocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: 'WI-NEW',
        reporter: 'me',
        sourceTool: 'work_items:create',
        reportKind: 'canonical-created',
        reportedTitle: 't',
        evidence: expect.objectContaining({ summary: 'fresh evidence' }),
      }),
    );
  });

  it('persists stable identity + achieved coverage on issue admission', async () => {
    guardM.mockResolvedValue(verdict([], []));
    const r = await createOneWorkItem({ kind: 'bug', title: 'Duplicate drain blockers file agents' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.admissionIdentity).toEqual({
      schemaVersion: 'admission-identity-v1',
      titleKey: 'title:agents blockers drain duplicate file',
    });
    expect(r.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          admissionIdentity: r.admissionIdentity,
          dedupCoverage: r.dedupCoverage,
        }),
      }),
    );
  });

  it('fails DRAIN bug admission closed when semantic coverage is unavailable, including force', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'direct drain blocker', force: true, requireCompleteDedupCoverage: true },
      ctx,
    );
    expect(r).toMatchObject({ ok: false, error: 'dedup_unavailable' });
    expect(createM).not.toHaveBeenCalled();
  });

  it('rejects an exact normalized identity match in DRAIN even when coverage is healthy', async () => {
    guardM.mockResolvedValue(verdict([], []));
    fulltextM.mockResolvedValue([
      {
        id: 'EI-9',
        title: 'Agents file duplicate drain blockers',
        state: 'open',
        harness: 'papercusp',
        similarity: 1,
        source: 'lexical-fulltext',
      },
    ]);
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'Duplicate blockers drain agents file', requireCompleteDedupCoverage: true },
      ctx,
    );
    expect(r).toMatchObject({ ok: false, error: 'duplicate_identity', existing: { id: 'EI-9' } });
    expect(createM).not.toHaveBeenCalled();
  });
});
