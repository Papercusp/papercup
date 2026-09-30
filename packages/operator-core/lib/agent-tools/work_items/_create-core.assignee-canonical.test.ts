/**
 * _create-core.assignee-canonical.test — EI-23701433507513915's entry backstop on
 * createOneWorkItem. A short-form owner id (`su-851c1a7a`, copied from a coord glyph
 * handle) was persisted verbatim as the holder, and every exact holder check then refused
 * the real holder. createOneWorkItem now expands a unique prefix before ANY read of
 * assign_to (repair UPDATE, admission bypass, audit echo, INSERT) and refuses an
 * ambiguous or unknown one instead of storing it. The work_items:create handler
 * canonicalizes (and downgrades) first; this is the backstop for every other caller.
 * The expand/resolve rules themselves are covered by work-item-holder-identity.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dedupEdgeMocks = vi.hoisted(() => ({
  persist: vi.fn(async (input: { candidates?: readonly { id: string }[] }) => input.candidates?.length ?? 0),
}));
vi.mock('./dedup-edges', () => ({ persistDedupEdges: dedupEdgeMocks.persist }));


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
vi.mock('../../datatype-registry-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../datatype-registry-store')>()),
  getGenericKindDatatype: vi.fn(async () => null),
  getDatatype: vi.fn(async () => null),
}));
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

// The holder-identity rules run for real, against an owner registry this file controls.
const OWNER_REGISTRY = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../../work-item-holder-identity', async (importOriginal) => {
  const { registryBackedHolderIdentity } = await import('../../work-item-holder-identity.testing');
  return registryBackedHolderIdentity(await importOriginal(), OWNER_REGISTRY);
});

import { createWorkItem } from '../../work-items';
import { createOneWorkItem } from './_create-core';

const createM = vi.mocked(createWorkItem);
const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };
const ME = 'su-851c1a7a-8ea6-4c70-afeb-472e957fd3d8';
const PEER_SAME_PREFIX = 'su-851c1a7a-0000-4000-8000-000000000001';

beforeEach(() => {
  OWNER_REGISTRY.ids = [];
  createM.mockClear();
  dedupEdgeMocks.persist.mockClear();
});

describe('createOneWorkItem × short-form assign_to (EI-23701433507513915)', () => {
  it('expands a UNIQUE short-form assign_to so the INSERT stamps the full owner id', async () => {
    OWNER_REGISTRY.ids = [ME];
    const r = await createOneWorkItem({ kind: 'bug', title: 'short assignee', assign_to: 'su-851c1a7a' }, ctx);
    expect(r.ok).toBe(true);
    expect(createM.mock.calls[0][0]).toMatchObject({ assignee: ME, admittedBy: 'bypass:explicit-assignment' });
  });

  it('refuses an AMBIGUOUS short-form assign_to and writes nothing', async () => {
    OWNER_REGISTRY.ids = [ME, PEER_SAME_PREFIX];
    const r = await createOneWorkItem({ kind: 'bug', title: 'ambiguous assignee', assign_to: 'su-851c1a7a' }, ctx);
    expect(r).toMatchObject({ ok: false, error: 'assignee_short_form_ambiguous' });
    expect(createM).not.toHaveBeenCalled();
  });

  it('refuses an UNRESOLVED short-form assign_to rather than persisting the prefix', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: 'unknown assignee', assign_to: 'su-deadbeef' }, ctx);
    expect(r).toMatchObject({ ok: false, error: 'assignee_short_form_unresolved' });
    expect(createM).not.toHaveBeenCalled();
  });

  it('passes a full id through untouched, with no lookup', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: 'full assignee', assign_to: ME }, ctx);
    expect(r.ok).toBe(true);
    expect(createM.mock.calls[0][0]).toMatchObject({ assignee: ME });
  });
});

