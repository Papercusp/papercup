/**
 * _create-core.semantic-dupe.test — the P-008 prescreen's wire-in contract on
 * createOneWorkItem: a hard cosine match refuses with `duplicate_semantic` +
 * the matched OPEN items; force:true skips the prescreen entirely; a soft
 * match creates WITH the `similarOpen` advisory; a null verdict (guard
 * fail-open) creates cleanly with no advisory key. The guard itself is
 * mocked — its internals are covered by semantic-dupe-guard.test.ts.
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

import { createOneWorkItem } from './_create-core';
import { findSemanticDupes, type SemanticDupeResult } from './semantic-dupe-guard';

const guardM = vi.mocked(findSemanticDupes);
const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

const verdict = (hard: number[], soft: number[]): SemanticDupeResult => ({
  hard: hard.map((s, i) => ({ id: `EI-${i + 1}`, title: `open dupe ${i + 1}`, state: 'open', harness: 'papercusp', similarity: s })),
  soft: soft.map((s, i) => ({ id: `WI-${i + 10}`, title: `near ${i}`, state: 'todo', harness: 'papercusp', similarity: s })),
  thresholds: { hard: 0.93, soft: 0.85 },
});

beforeEach(() => {
  guardM.mockReset();
  guardM.mockResolvedValue(null);
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
    const r = await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect('similarOpen' in r).toBe(false);
  });
});
