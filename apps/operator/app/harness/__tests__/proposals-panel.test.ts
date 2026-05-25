/**
 * @vitest-environment node
 *
 * P-029 — ProposalsPanel unit tests covering:
 *   - Pure adapter/helper functions (draftPlanToCard, legacyRowToCard, titleFromBody, fmtAge)
 *   - mergeProposalCards deduplication logic
 *   - filterCards search logic
 *   - rejectDraftPlan CAS mechanism (mocked fetch)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  draftPlanToCard,
  legacyRowToCard,
  titleFromBody,
  fmtAge,
  mergeProposalCards,
  filterCards,
  type DraftPlanRow,
  type LegacyProposalRow,
} from '../proposals-panel-utils';

/* ── fixtures ─────────────────────────────────────────────────────── */

function makeDraftRow(overrides: Partial<DraftPlanRow> = {}): DraftPlanRow {
  return {
    slug: 'my-feature-2026-05-24',
    title: 'My Feature',
    status: 'draft',
    nowState: 'Building the thing.',
    nowNext: 'Start with the schema.',
    itemCount: 3,
    source: 'user',
    created: '2026-05-24T10:00:00Z',
    updated: '2026-05-24T11:00:00Z',
    ...overrides,
  };
}

function makeLegacyRow(overrides: Partial<LegacyProposalRow> = {}): LegacyProposalRow {
  return {
    proposalId: 'prop-abc123',
    status: 'pending',
    ts: 1716494400000,
    payload: { body: '## My Legacy Proposal\n\nSome text.' },
    ...overrides,
  };
}

/* ── draftPlanToCard ──────────────────────────────────────────────── */

describe('draftPlanToCard', () => {
  it('maps slug → id', () => {
    const card = draftPlanToCard(makeDraftRow());
    expect(card.id).toBe('my-feature-2026-05-24');
  });

  it('sets kind = draft-plan', () => {
    expect(draftPlanToCard(makeDraftRow()).kind).toBe('draft-plan');
  });

  it('uses updated over created for updatedAt', () => {
    const card = draftPlanToCard(makeDraftRow({ updated: '2026-05-25T00:00:00Z', created: '2026-05-24T00:00:00Z' }));
    expect(card.updatedAt).toBe('2026-05-25T00:00:00Z');
  });

  it('falls back to created when updated is null', () => {
    const card = draftPlanToCard(makeDraftRow({ updated: null, created: '2026-05-24T00:00:00Z' }));
    expect(card.updatedAt).toBe('2026-05-24T00:00:00Z');
  });

  it('maps nowState → summary', () => {
    const card = draftPlanToCard(makeDraftRow({ nowState: 'Phase 1 done.' }));
    expect(card.summary).toBe('Phase 1 done.');
  });

  it('summary is null when nowState is null', () => {
    const card = draftPlanToCard(makeDraftRow({ nowState: null }));
    expect(card.summary).toBeNull();
  });

  it('maps source correctly', () => {
    expect(draftPlanToCard(makeDraftRow({ source: 'scoper' })).source).toBe('scoper');
    expect(draftPlanToCard(makeDraftRow({ source: 'user' })).source).toBe('user');
  });
});

/* ── titleFromBody ────────────────────────────────────────────────── */

describe('titleFromBody', () => {
  it('extracts H1 title', () => {
    expect(titleFromBody('# Hello World\n\ntext', 'fallback')).toBe('Hello World');
  });

  it('extracts H2 title', () => {
    expect(titleFromBody('## Section\n\ntext', 'fallback')).toBe('Section');
  });

  it('extracts H3 title', () => {
    expect(titleFromBody('### Sub\n\ntext', 'fallback')).toBe('Sub');
  });

  it('ignores leading blank lines and finds first heading', () => {
    expect(titleFromBody('\n\n## Found\n\ntext', 'fallback')).toBe('Found');
  });

  it('returns fallback when no heading present', () => {
    expect(titleFromBody('just prose text\nno heading', 'my-fallback')).toBe('my-fallback');
  });

  it('returns fallback for empty body', () => {
    expect(titleFromBody('', 'fb')).toBe('fb');
  });
});

/* ── legacyRowToCard ──────────────────────────────────────────────── */

describe('legacyRowToCard', () => {
  it('sets kind = legacy', () => {
    expect(legacyRowToCard(makeLegacyRow()).kind).toBe('legacy');
  });

  it('extracts title from payload body heading', () => {
    const card = legacyRowToCard(makeLegacyRow({ payload: { body: '## My Legacy Proposal\n\nText' } }));
    expect(card.title).toBe('My Legacy Proposal');
  });

  it('falls back to proposalId when body has no heading', () => {
    const card = legacyRowToCard(makeLegacyRow({ payload: { body: 'plain text no heading' } }));
    expect(card.title).toBe('prop-abc123');
  });

  it('falls back to proposalId when payload is missing', () => {
    const card = legacyRowToCard(makeLegacyRow({ payload: undefined }));
    expect(card.title).toBe('prop-abc123');
  });

  it('source is null', () => {
    expect(legacyRowToCard(makeLegacyRow()).source).toBeNull();
  });

  it('itemCount is null', () => {
    expect(legacyRowToCard(makeLegacyRow()).itemCount).toBeNull();
  });

  it('summary is null', () => {
    expect(legacyRowToCard(makeLegacyRow()).summary).toBeNull();
  });
});

/* ── fmtAge ───────────────────────────────────────────────────────── */

describe('fmtAge', () => {
  it('returns empty string for null', () => {
    expect(fmtAge(null)).toBe('');
  });

  it('returns empty string for invalid date', () => {
    expect(fmtAge('not-a-date')).toBe('');
  });

  it('returns "just now" for times within the last minute', () => {
    const iso = new Date(Date.now() - 30_000).toISOString();
    expect(fmtAge(iso)).toBe('just now');
  });

  it('returns Nm ago for recent times', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(fmtAge(iso)).toBe('5m ago');
  });

  it('returns Nh ago for times within 48 hours', () => {
    const iso = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(fmtAge(iso)).toBe('3h ago');
  });

  it('returns Nd ago for times older than 48 hours', () => {
    const iso = new Date(Date.now() - 3 * 86400_000).toISOString();
    expect(fmtAge(iso)).toBe('3d ago');
  });
});

/* ── mergeProposalCards ───────────────────────────────────────────── */

describe('mergeProposalCards', () => {
  it('returns draft cards first', () => {
    const draft = makeDraftRow({ slug: 'draft-a', title: 'Draft A' });
    const legacy = makeLegacyRow({ proposalId: 'legacy-b' });
    const cards = mergeProposalCards([draft], [legacy]);
    expect(cards[0].id).toBe('draft-a');
    expect(cards[1].id).toBe('legacy-b');
  });

  it('deduplicates: legacy row with same id as a draft slug is excluded', () => {
    const draft = makeDraftRow({ slug: 'shared-id' });
    const legacy = makeLegacyRow({ proposalId: 'shared-id' });
    const cards = mergeProposalCards([draft], [legacy]);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe('draft-plan');
  });

  it('filters out non-pending legacy rows', () => {
    const legacy = makeLegacyRow({ status: 'rejected' });
    const cards = mergeProposalCards([], [legacy]);
    expect(cards).toHaveLength(0);
  });

  it('includes pending legacy rows not matching any draft slug', () => {
    const legacy = makeLegacyRow({ proposalId: 'unique-legacy', status: 'pending' });
    const cards = mergeProposalCards([], [legacy]);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe('legacy');
  });

  it('handles empty inputs', () => {
    expect(mergeProposalCards([], [])).toEqual([]);
  });
});

/* ── filterCards ──────────────────────────────────────────────────── */

describe('filterCards', () => {
  const cards = [
    { kind: 'draft-plan' as const, id: 'auth-system-2026-05-24', title: 'Auth System', summary: 'OAuth2 integration', source: 'user' as const, itemCount: 4, updatedAt: null },
    { kind: 'draft-plan' as const, id: 'billing-fix-2026-05-24', title: 'Billing Fix', summary: null, source: 'scoper' as const, itemCount: 2, updatedAt: null },
    { kind: 'legacy' as const, id: 'prop-abc', title: 'Old Proposal', summary: null, source: null, itemCount: null, updatedAt: null },
  ];

  it('returns all cards when query is empty', () => {
    expect(filterCards(cards, '')).toHaveLength(3);
  });

  it('returns all cards when query is whitespace', () => {
    expect(filterCards(cards, '   ')).toHaveLength(3);
  });

  it('filters by title (case-insensitive)', () => {
    const result = filterCards(cards, 'auth');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('auth-system-2026-05-24');
  });

  it('filters by summary text', () => {
    const result = filterCards(cards, 'oauth2');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('auth-system-2026-05-24');
  });

  it('filters by id', () => {
    const result = filterCards(cards, 'prop-abc');
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('legacy');
  });

  it('returns empty array when nothing matches', () => {
    expect(filterCards(cards, 'xyzzy')).toHaveLength(0);
  });
});

/* ── rejectDraftPlan ──────────────────────────────────────────────── */

describe('rejectDraftPlan', () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3055' } });
  });

  // getJson parses r.json() directly; postJson parses r.text() as JSON.
  function planResponse(raw: string, contentHash = 'abc123') {
    return {
      ok: true,
      json: async () => ({ raw, contentHash, items: [], slug: 'test', archived: false, legacy: false }),
    } as unknown as Response;
  }

  function planErrorResponse(error: string) {
    return {
      ok: true,
      json: async () => ({ error, slug: 'test', archived: false, legacy: false }),
    } as unknown as Response;
  }

  function setContentResponse(ok = true) {
    return {
      ok: true,
      text: async () => JSON.stringify({ ok }),
    } as unknown as Response;
  }

  it('replaces status: draft with status: superseded and calls set-content', async () => {
    const raw = `---\ntitle: My Plan\nstatus: draft\n---\n\n## Now\n\nDraft content.`;
    mockFetch
      .mockResolvedValueOnce(planResponse(raw))     // fetchPlan call (getJson)
      .mockResolvedValueOnce(setContentResponse()); // setPlanContent call (postJson)

    const { rejectDraftPlan } = await import('../../admin/plans/plans-api');
    const result = await rejectDraftPlan('my-plan-2026-05-24');

    expect(result.ok).toBe(true);

    // Verify set-content was called with the updated content
    const setContentCall = mockFetch.mock.calls[1];
    const body = JSON.parse(setContentCall[1]?.body as string);
    expect(body.content).toContain('status: superseded');
    expect(body.content).not.toContain('status: draft');
    expect(body.expectedHash).toBe('abc123');
  });

  it('returns ok:false with error=status_not_draft when plan is not draft', async () => {
    const raw = `---\ntitle: My Plan\nstatus: active\n---\n`;
    mockFetch.mockResolvedValueOnce(planResponse(raw));

    const { rejectDraftPlan } = await import('../../admin/plans/plans-api');
    const result = await rejectDraftPlan('my-plan-2026-05-24');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('status_not_draft');
    // set-content should NOT have been called
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false when fetchPlan returns an error field', async () => {
    mockFetch.mockResolvedValueOnce(planErrorResponse('not_found'));

    const { rejectDraftPlan } = await import('../../admin/plans/plans-api');
    const result = await rejectDraftPlan('nonexistent-plan');

    expect(result.ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
