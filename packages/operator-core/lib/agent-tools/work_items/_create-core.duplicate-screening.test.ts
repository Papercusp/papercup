/**
 * _create-core.duplicate-screening.test — the project's own duplicate-screening level decides
 * whether a newly filed item is held for the scheduled review (work-items-duplicate-screening).
 *
 * `all` (the default, and what an unregistered or unreadable project gets) holds every kind,
 * as before the setting existed. `bugs` holds only bugs. `off` holds nothing. A filing-time
 * bypass still comes first and keeps its own reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dedupEdgeMocks = vi.hoisted(() => ({
  persist: vi.fn(async (input: { candidates?: readonly { id: string }[] }) => input.candidates?.length ?? 0),
}));
vi.mock('./dedup-edges', () => ({ persistDedupEdges: dedupEdgeMocks.persist }));


vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
// The real store module with its writers stubbed: the create path's own imports read more of
// it than a hand-listed stand-in can keep up with.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  createWorkItem: vi.fn(async (input: { kind: string; title: string }) => ({
    id: 'WI-NEW',
    kind: input.kind,
    title: input.title,
  })),
  getWorkItem: vi.fn(async () => null),
  getWorkItemDetail: vi.fn(async () => null),
  linkWorkItem: vi.fn(async () => {}),
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

// The registry the policy reads: one project per level, and `papercusp` with no level set.
const REGISTRY = vi.hoisted(() => ({
  projects: [
    { slug: 'small', path: '/p/small', configOverrides: { duplicateScreening: 'off' } },
    { slug: 'bugsonly', path: '/p/bugsonly', configOverrides: { duplicateScreening: 'bugs' } },
    { slug: 'papercusp', path: '/p/papercusp' },
  ],
}));
vi.mock('../../harness-registry', () => ({ loadHarnessRegistry: vi.fn(async () => REGISTRY) }));

import { createWorkItem } from '../../work-items';
import { createOneWorkItem } from './_create-core';

const createM = vi.mocked(createWorkItem);
const ctxFor = (harnessSlug: string) => ({ ownerId: 'me', workspaceId: 'default', harnessSlug });
const born = () => {
  const input = createM.mock.calls[0][0] as { admission?: string; admittedBy?: string | null };
  return { admission: input.admission, admittedBy: input.admittedBy ?? null };
};

beforeEach(() => {
  OWNER_REGISTRY.ids = [];
  createM.mockClear();
  dedupEdgeMocks.persist.mockClear();
});

describe('createOneWorkItem × the project\'s duplicate-screening level', () => {
  it('holds a change in a project that set no level, as before the setting existed', async () => {
    const r = await createOneWorkItem({ kind: 'change', title: 'plain project change', harness: 'papercusp' }, ctxFor('papercusp'));
    expect(r.ok).toBe(true);
    expect(born()).toEqual({ admission: 'pending', admittedBy: null });
  });

  it('admits a change at birth in a project that screens nothing, under the policy\'s name', async () => {
    const r = await createOneWorkItem({ kind: 'change', title: 'small project change', harness: 'small' }, ctxFor('small'));
    expect(r.ok).toBe(true);
    expect(born()).toEqual({ admission: 'auto', admittedBy: 'policy:duplicate-screening-off' });
  });

  it('admits a bug at birth too when the project screens nothing', async () => {
    await createOneWorkItem({ kind: 'bug', title: 'small project bug', harness: 'small' }, ctxFor('small'));
    expect(born()).toEqual({ admission: 'auto', admittedBy: 'policy:duplicate-screening-off' });
  });

  it('holds the bug and admits the change in a project that screens only bugs', async () => {
    await createOneWorkItem({ kind: 'bug', title: 'bugs-only project bug', harness: 'bugsonly' }, ctxFor('bugsonly'));
    expect(born()).toEqual({ admission: 'pending', admittedBy: null });
    createM.mockClear();
    await createOneWorkItem({ kind: 'change', title: 'bugs-only project change', harness: 'bugsonly' }, ctxFor('bugsonly'));
    expect(born()).toEqual({ admission: 'auto', admittedBy: 'policy:duplicate-screening-bugs' });
  });

  it('keeps a filing-time bypass\'s own reason ahead of the project\'s level', async () => {
    await createOneWorkItem({ kind: 'bug', title: 'critical in a small project', harness: 'small', severity: 'critical' }, ctxFor('small'));
    expect(born()).toEqual({ admission: 'auto', admittedBy: 'bypass:severity-critical' });
  });
});
