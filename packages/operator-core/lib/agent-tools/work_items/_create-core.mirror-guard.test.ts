/**
 * _create-core.mirror-guard.test — the EI-316 mirror guard's wire-in contract,
 * and specifically its FOLLOW-UP blind spot (EI-18816637571744179).
 *
 * The guard fires on "the title names an existing OPEN work-item id", which is a
 * real accidental-mirror signal — but it is equally the signature of the most
 * ordinary filing there is: a follow-up naming its parent for lineage. Those are
 * opposites. A mirror duplicates a parent's scope; a follow-up records the scope
 * the parent deliberately EXCLUDED, and is usually filed exactly when the parent
 * is being closed, so "work that item directly" is the one thing that cannot
 * work.
 *
 * The discriminator was already on the call and simply not consulted: an
 * explicit typed link to the very item the title names is a DECLARATION that the
 * author knows about it, which is the opposite of the accidental mirror this
 * guard exists to catch.
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

import { createOneWorkItem } from './_create-core';
import { findMirroredOpenItem } from './mirror-guard';
import { getFlag } from '@papercusp/flags/server';

const mirrorM = vi.mocked(findMirroredOpenItem);
const flagM = vi.mocked(getFlag);
const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

const TITLE = 'follow-up to WI-9: the part WI-9 deliberately did not do';

beforeEach(() => {
  vi.clearAllMocks();
  // The mirror guard is flag-gated; turn it ON for this suite.
  flagM.mockResolvedValue(true as never);
  mirrorM.mockResolvedValue({ id: 'WI-9', state: 'open' });
});

describe('createOneWorkItem × EI-316 mirror guard', () => {
  // The guard's real job, unchanged.
  it('refuses a title naming an open item when nothing declares the reference', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: TITLE }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('duplicate_mirror');
    expect(r.existing).toEqual({ id: 'WI-9', state: 'open' });
  });

  it('force:true still overrides, unchanged', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: TITLE, force: true }, ctx);
    expect(r.ok).toBe(true);
    expect(mirrorM).not.toHaveBeenCalled();
  });

  // EI-18816637571744179 — the follow-up case.
  it('ALLOWS the create when an explicit typed link targets the very item the title names', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: TITLE, links: [{ rel: 'relates', target_id: 'WI-9' }] },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts any lineage rel, not just relates', async () => {
    for (const rel of ['caused-by', 'investigates', 'about', 'revises', 'fixes', 'blocks']) {
      const r = await createOneWorkItem(
        { kind: 'bug', title: TITLE, links: [{ rel, target_id: 'WI-9' }] },
        ctx,
      );
      expect(r.ok, `rel=${rel} should not be treated as a mirror`).toBe(true);
    }
  });

  it('matches the id case-insensitively', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: TITLE, links: [{ rel: 'relates', target_id: 'wi-9' }] },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  // The bypass is a DECLARATION OF LINEAGE, so it must be scoped to the item the
  // title actually names — a link to something else says nothing about this id.
  it('still refuses when the link targets a DIFFERENT item', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: TITLE, links: [{ rel: 'relates', target_id: 'WI-1234' }] },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('duplicate_mirror');
  });

  // `duplicates` is deliberately NOT a lineage declaration: saying "this
  // duplicates WI-9" is precisely the condition the guard names, so it must not
  // be the thing that switches the guard off.
  it('still refuses when the declared rel is `duplicates`', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: TITLE, links: [{ rel: 'duplicates', target_id: 'WI-9' }] },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('duplicate_mirror');
  });

  // The old message only offered "work that item directly", which is wrong (and
  // impossible) for the follow-up case — so the refusal must name that reading.
  it('offers the follow-up reading in the refusal, not only force:true', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: TITLE }, ctx);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('WI-9');
    expect(r.message).toMatch(/follow-up/i);
    expect(r.message).toContain('links');
  });
});
