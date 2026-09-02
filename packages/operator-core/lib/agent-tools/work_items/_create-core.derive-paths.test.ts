/**
 * _create-core.derive-paths.test — EI-16028's fallback wire-in on createOneWorkItem:
 * when the caller passes NO explicit `payload.paths`, derive candidates from the
 * item's own title/summary text so the scheduler's `affinity` rank term (which reads
 * `payload.paths`) has something to work with. An explicit `payload.paths` — INCLUDING
 * an explicit empty array — is never overridden.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
  resolveHarnessContentPath: vi.fn(() => undefined),
}));
// EI-21872682653374832 — `createOneWorkItem` stamps goal provenance (_create-core.ts:1199).
// Unmocked, `resolveGoalContext` reaches the real authority read, which fails CLOSED with
// `goal_holder_authority_unreadable` (goal-context.ts:54) because no fixture can supply that
// authority. The stamp's catch console.warns by design (EI-20075667133396690, so a stamp that
// THREW stays distinguishable from one that correctly DECLINED), and vitest-fail-on-console
// turns that warn into a failure — reddening all 9 tests here before any of them reach their
// own assertion. Returning null is the honest fixture answer: this agent runs under no goal,
// which is the majority production path and the one these tests actually mean to exercise.
// Do NOT "fix" this by silencing the production warn; the warn is the feature.
vi.mock('../../modes/goal-context', () => ({
  resolveGoalContext: vi.fn(async () => null),
}));

import { createOneWorkItem, selectExplicitRepoPathRoot } from './_create-core';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp', projectDir: repoRoot };
let targetRoot: string;

beforeEach(() => {
  createWorkItemMock.mockClear();
  vi.mocked(loadHarnessRegistry).mockResolvedValue({ projects: [] });
  vi.mocked(resolveHarnessContentPath).mockReturnValue(undefined);
});

beforeAll(() => {
  targetRoot = mkdtempSync(`${tmpdir()}/work-item-target-root-`);
  mkdirSync(`${targetRoot}/apps/api/src/scout`, { recursive: true });
  writeFileSync(`${targetRoot}/apps/api/src/scout/scout.service.ts`, 'export const scout = true;\n');
  writeFileSync(
    `${targetRoot}/apps/api/src/scout/scout-runtime.integration.test.ts`,
    'export const runtime = true;\n',
  );
});

afterAll(() => rmSync(targetRoot, { recursive: true, force: true }));

describe('createOneWorkItem × path-affinity fallback (EI-16028)', () => {
  it('derives payload.paths from title+summary when the caller supplied none', async () => {
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'crash in packages/operator-core/lib/agent-tools/work_items/_create-core.ts',
        summary:
          'see packages/operator-core/lib/agent-tools/work_items/_derive-paths.ts too; ' +
          'grep over apps/packages/libs/scripts and ignore packages/operator-core/' +
          '../'.repeat(6) +
          'etc/passwd',
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as { payload?: { paths?: string[] } };
    expect(call.payload?.paths).toEqual([
      'packages/operator-core/lib/agent-tools/work_items/_create-core.ts',
      'packages/operator-core/lib/agent-tools/work_items/_derive-paths.ts',
    ]);
  });

  it('keeps explicit paths unchanged but returns a warn-only advisory for a missing path', async () => {
    const explicit = 'packages/operator-core/lib/agent-tools/work-items/complete.ts';
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'source path spelling drift',
        payload: { paths: [explicit] },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect((r.workItem.payload as { paths?: string[] } | null)?.paths).toEqual([explicit]);
    expect(r.explicitPathsWarning).toContain(explicit);
    expect(r.explicitPathsWarning).toMatch(/advisory only/);
  });

  it('does not warn when an explicit path exists in the selected tree', async () => {
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'source path is present',
        payload: { paths: ['packages/operator-core/lib/agent-tools/work_items/complete.ts'] },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.explicitPathsWarning).toBeUndefined();
  });

  it('validates explicit paths against the target harness and names the selected source', async () => {
    vi.mocked(resolveHarnessContentPath).mockReturnValue(targetRoot);
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        harness: 'sidestage',
        title: 'target harness source paths',
        payload: {
          paths: [
            'apps/api/src/scout/scout.service.ts',
            'apps/api/src/scout/scout-runtime.integration.test.ts',
          ],
        },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.explicitPathsWarning).toBeUndefined();
    expect(loadHarnessRegistry).toHaveBeenCalledWith('default');
  });

  it('warns against the target harness tree and includes its provenance', async () => {
    vi.mocked(resolveHarnessContentPath).mockReturnValue(targetRoot);
    const missing = 'apps/api/src/scout/missing.ts';
    expect(await selectExplicitRepoPathRoot([missing], ctx, 'sidestage')).toEqual({
      root: targetRoot,
      source: 'target-harness',
    });
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        harness: 'sidestage',
        title: 'target harness missing source path',
        payload: { paths: [missing] },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.explicitPathsWarning).toContain(missing);
    expect(r.explicitPathsWarning).toContain('source: target-harness');
    expect(r.explicitPathsWarning).toContain(`root: ${targetRoot}`);
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
      {
        kind: 'bug',
        title: 'crash in packages/operator-core/lib/agent-tools/work_items/_create-core.ts',
        payload: { severity_hint: 'high' },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as { payload?: { paths?: string[]; severity_hint?: string } };
    expect(call.payload?.severity_hint).toBe('high');
    expect(call.payload?.paths).toEqual(['packages/operator-core/lib/agent-tools/work_items/_create-core.ts']);
  });
});
