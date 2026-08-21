/**
 * _create-core.derive-paths.test — EI-16028's fallback wire-in on createOneWorkItem:
 * when the caller passes NO explicit `payload.paths`, derive candidates from the
 * item's own title/summary text so the scheduler's `affinity` rank term (which reads
 * `payload.paths`) has something to work with. An explicit `payload.paths` — INCLUDING
 * an explicit empty array — is never overridden.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
const createWorkItemMock = vi.fn(async (input: { kind: string; title: string; payload?: Record<string, unknown> }) => ({
  id: 'WI-NEW',
  kind: input.kind,
  title: input.title,
  payload: input.payload,
}));
vi.mock('../../work-items', () => ({
  createWorkItem: (...args: unknown[]) => createWorkItemMock(...(args as [never])),
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
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} }) }));
vi.mock('../../datatype-registry-store', () => ({ getGenericKindDatatype: vi.fn(async () => null) }));
vi.mock('../../datatype-payload-validation', () => ({ validateDatatypePayload: () => ({ ok: true as const }) }));
vi.mock('../../routing-gate-hints', () => ({ matchRoutingGateHint: () => null }));
vi.mock('../../issue-blocks-merge', () => ({ planItemRef: (s: string, i: string) => `${s}#${i}`, PLAN_ITEM_KIND: 'plan_item' }));
vi.mock('./semantic-dupe-guard', () => ({ findSemanticDupes: vi.fn(async () => null) }));
vi.mock('./recent-lexical-dupe-guard', () => ({ findRecentLexicalDupes: vi.fn(async () => null) }));
vi.mock('./fulltext-lexical-dupe-guard', () => ({ findFulltextLexicalDupes: vi.fn(async () => null) }));

import { createOneWorkItem } from './_create-core';

const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

beforeEach(() => {
  createWorkItemMock.mockClear();
});

describe('createOneWorkItem × path-affinity fallback (EI-16028)', () => {
  it('derives payload.paths from title+summary when the caller supplied none', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'crash in packages/operator-core/lib/foo.ts', summary: 'see libs/papercusp/lib/bar.ts too' },
      ctx,
    );
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as { payload?: { paths?: string[] } };
    expect(call.payload?.paths).toEqual(['packages/operator-core/lib/foo.ts', 'libs/papercusp/lib/bar.ts']);
  });

  it('leaves payload untouched when title/summary carry no derivable path', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: 'the gateway is confused' }, ctx);
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as { payload?: { paths?: string[] } };
    expect(call.payload?.paths).toBeUndefined();
  });

  it('never clobbers an explicit non-empty payload.paths', async () => {
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'crash in packages/operator-core/lib/foo.ts',
        payload: { paths: ['apps/operator/app/explicit.tsx'] },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as { payload?: { paths?: string[] } };
    expect(call.payload?.paths).toEqual(['apps/operator/app/explicit.tsx']);
  });

  it('never clobbers an explicit EMPTY payload.paths (caller\'s deliberate opt-out)', async () => {
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'crash in packages/operator-core/lib/foo.ts',
        payload: { paths: [] },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as { payload?: { paths?: string[] } };
    expect(call.payload?.paths).toEqual([]);
  });

  it('preserves other payload keys alongside the derived paths', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'crash in packages/operator-core/lib/foo.ts', payload: { severity_hint: 'high' } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as { payload?: { paths?: string[]; severity_hint?: string } };
    expect(call.payload?.severity_hint).toBe('high');
    expect(call.payload?.paths).toEqual(['packages/operator-core/lib/foo.ts']);
  });
});
