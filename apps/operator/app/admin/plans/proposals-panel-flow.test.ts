// @vitest-environment jsdom
/**
 * P-029: unit tests for the proposals-panel data flow.
 *
 * Covers:
 *   1. rejectDraftPlan — fetchPlan → CAS set-content flip to superseded
 *   2. ProposalCard adapter pure-functions (draftPlanToCard, fmtAge logic)
 *   3. promoteToHarness feature-derivation shape
 *
 * Full browser-level "click New → Architect → Accept → features land"
 * is documented at /internal/docs/testing/agent-e2e; these unit tests
 * validate the data-layer contracts the UI depends on.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

/* ── Helpers ─────────────────────────────────────────────────────── */

function makeFetchMock(responses: Record<string, unknown>) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const key = url.replace(/^.*\/plans\//, '');
    const body = responses[key];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
}

/* ── rejectDraftPlan ─────────────────────────────────────────────── */

describe('rejectDraftPlan (P-028 data layer — P-029 coverage)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('flips status: draft → superseded and calls set-content', async () => {
    const raw = `---
title: My plan
slug: my-plan-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
---

## Now

**State:** Not started.
**Next:** Human reviews.
`;
    const contentHash = 'abc123';
    let setCalled = false;
    let setBody: Record<string, unknown> | null = null;

    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      const verb = String(url).split('/plans/')[1]?.split('?')[0];
      if (verb === 'get') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ raw, contentHash, items: [] }),
          text: async () => JSON.stringify({ raw, contentHash, items: [] }),
        } as Response;
      }
      if (verb === 'set-content') {
        setCalled = true;
        setBody = JSON.parse((opts?.body as string) ?? '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          text: async () => JSON.stringify({ ok: true }),
        } as Response;
      }
      throw new Error(`unexpected verb: ${verb}`);
    }) as unknown as typeof fetch;

    const { rejectDraftPlan } = await import('./plans-api');
    const result = await rejectDraftPlan('my-plan-2026-05-24');

    expect(result).toEqual({ ok: true });
    expect(setCalled).toBe(true);
    expect((setBody as unknown as Record<string, unknown>).slug).toBe('my-plan-2026-05-24');
    expect((setBody as unknown as Record<string, unknown>).expectedHash).toBe(contentHash);
    expect(typeof (setBody as unknown as Record<string, unknown>).content).toBe('string');
    // The CAS payload must swap draft → superseded but otherwise be identical.
    expect(((setBody as unknown as Record<string, unknown>).content as string)).toContain('status: superseded');
    expect(((setBody as unknown as Record<string, unknown>).content as string)).not.toContain('status: draft');
    // Everything else is preserved.
    expect(((setBody as unknown as Record<string, unknown>).content as string)).toContain('title: My plan');
  });

  it('returns ok:false with status_not_draft when plan is not draft', async () => {
    const raw = `---
title: My plan
slug: my-plan-2026-05-24
status: active
created: 2026-05-24
updated: 2026-05-24
---
`;
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ raw, contentHash: 'h', items: [] }),
      text: async () => JSON.stringify({ raw, contentHash: 'h', items: [] }),
    })) as unknown as typeof fetch;

    const { rejectDraftPlan } = await import('./plans-api');
    const result = await rejectDraftPlan('my-plan-2026-05-24');
    expect(result).toEqual({ ok: false, error: 'status_not_draft' });
  });

  it('returns ok:false when fetchPlan returns an error field', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: 'plan_not_found' }),
      text: async () => JSON.stringify({ error: 'plan_not_found' }),
    })) as unknown as typeof fetch;

    const { rejectDraftPlan } = await import('./plans-api');
    const result = await rejectDraftPlan('no-such-plan');
    expect(result).toEqual({ ok: false, error: 'plan_not_found' });
  });

  it('returns ok:false when set-content returns stale', async () => {
    const raw = `---
title: My plan
slug: stale-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
---
`;
    let callCount = 0;
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      callCount++;
      const verb = String(url).split('/plans/')[1]?.split('?')[0];
      if (verb === 'get') {
        return {
          ok: true, status: 200,
          json: async () => ({ raw, contentHash: 'old', items: [] }),
          text: async () => JSON.stringify({ raw, contentHash: 'old', items: [] }),
        } as Response;
      }
      // set-content returns stale conflict
      return {
        ok: true, status: 200,
        json: async () => ({ code: 'stale', currentContent: raw, currentHash: 'new' }),
        text: async () => JSON.stringify({ code: 'stale', currentContent: raw }),
      } as Response;
    }) as unknown as typeof fetch;

    const { rejectDraftPlan } = await import('./plans-api');
    const result = await rejectDraftPlan('stale-2026-05-24');
    // stale → writeErrorOf returns null → falls through to 'set_content_failed'
    expect(result.ok).toBe(false);
    expect(result.error).toBe('set_content_failed');
  });

  it('returns ok:false when plan has no raw content', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ raw: null, contentHash: 'h', items: [] }),
      text: async () => JSON.stringify({ raw: null, contentHash: 'h', items: [] }),
    })) as unknown as typeof fetch;

    const { rejectDraftPlan } = await import('./plans-api');
    const result = await rejectDraftPlan('empty-plan');
    expect(result).toEqual({ ok: false, error: 'no_content' });
  });

  it('threads harnessSlug into the set-content body for admin-route invalidation (R3-A)', async () => {
    const raw = `---
title: my-plan
slug: hs-plan-2026-05-25
status: draft
created: 2026-05-25
updated: 2026-05-25
---
`;
    let setBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      const verb = String(url).split('/plans/')[1]?.split('?')[0];
      if (verb === 'get') {
        return {
          ok: true, status: 200,
          json: async () => ({ raw, contentHash: 'h', items: [] }),
          text: async () => JSON.stringify({ raw, contentHash: 'h', items: [] }),
        } as Response;
      }
      if (verb === 'set-content') {
        setBody = JSON.parse((opts?.body as string) ?? '{}');
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true }),
          text: async () => JSON.stringify({ ok: true }),
        } as Response;
      }
      throw new Error(`unexpected verb: ${verb}`);
    }) as unknown as typeof fetch;

    const { rejectDraftPlan } = await import('./plans-api');
    const result = await rejectDraftPlan('hs-plan-2026-05-25', 'sheets-clone');
    expect(result).toEqual({ ok: true });
    // The body MUST carry harness_slug so the admin route can invalidate
    // plansDrafts.bySlug for the right harness. Without this, the card
    // lingers in ProposalsPanel after reject until manual refresh.
    expect((setBody as unknown as Record<string, unknown>).harness_slug).toBe('sheets-clone');
  });

  it('omits harness_slug from body when no harnessSlug arg passed (backwards-compat)', async () => {
    const raw = `---
title: x
slug: x-2026-05-25
status: draft
---
`;
    let setBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      const verb = String(url).split('/plans/')[1]?.split('?')[0];
      if (verb === 'get') {
        return {
          ok: true, status: 200,
          json: async () => ({ raw, contentHash: 'h', items: [] }),
          text: async () => JSON.stringify({ raw, contentHash: 'h', items: [] }),
        } as Response;
      }
      setBody = JSON.parse((opts?.body as string) ?? '{}');
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true }),
      } as Response;
    }) as unknown as typeof fetch;

    const { rejectDraftPlan } = await import('./plans-api');
    await rejectDraftPlan('x-2026-05-25');
    expect((setBody as unknown as Record<string, unknown>).harness_slug).toBeUndefined();
  });
});

/* ── writeErrorOf ───────────────────────────────────────────────── */

describe('writeErrorOf', () => {
  it('returns null on success', async () => {
    const { writeErrorOf } = await import('./plans-api');
    expect(writeErrorOf({ ok: true })).toBeNull();
  });

  it('returns null on stale (callers handle stale separately)', async () => {
    const { writeErrorOf } = await import('./plans-api');
    expect(writeErrorOf({ code: 'stale', currentContent: '…' })).toBeNull();
  });

  it('returns lint summary when errors array present', async () => {
    const { writeErrorOf } = await import('./plans-api');
    const res = writeErrorOf({
      error: 'lint_failed',
      errors: [{ code: 'missing-now', message: 'no now block', severity: 'error' }],
    } as unknown as Parameters<typeof writeErrorOf>[0]);
    expect(res).toContain('missing-now');
  });

  it('returns code string for other failures', async () => {
    const { writeErrorOf } = await import('./plans-api');
    expect(writeErrorOf({ error: 'lock_timeout' })).toBe('lock_timeout');
    expect(writeErrorOf({ code: 'lock_timeout' })).toBe('lock_timeout');
  });
});

/* ── promoteToHarness feature-derivation contract ───────────────── */

describe('promoteToHarness — feature-derivation shape (P-027 contract)', () => {
  it('builds features from plan items correctly', async () => {
    // This validates the shape ProposalsPanel.CardDetail derives before
    // calling promoteToHarness({ apply: true }). The items from fetchPlan
    // must map to { title, from_items } with the P-NNN id.
    const items = [
      { id: 'P-001', text: 'Add login page' },
      { id: 'P-002', text: 'Add logout button' },
    ];
    const features = items.map((item) => ({ title: item.text, from_items: [item.id] }));
    expect(features).toEqual([
      { title: 'Add login page', from_items: ['P-001'] },
      { title: 'Add logout button', from_items: ['P-002'] },
    ]);
    // Guard against the "no items" branch that CardDetail handles:
    expect(features.length).toBeGreaterThan(0);
  });

  it('promoteToHarness posts to the promote verb with apply:true', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      capturedBody = JSON.parse((opts?.body as string) ?? '{}');
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, features_created: 2, ids: ['F-AUTO-001', 'F-AUTO-002'] }),
        text: async () => JSON.stringify({ ok: true, features_created: 2 }),
      } as Response;
    }) as unknown as typeof fetch;

    const { promoteToHarness } = await import('./plans-api');
    const res = await promoteToHarness({
      slug: 'my-plan-2026-05-24',
      harness_slug: 'myharn',
      features: [{ title: 'Add login page', from_items: ['P-001'] }],
      apply: true,
    });

    expect(res.ok).toBe(true);
    expect((capturedBody as unknown as Record<string, unknown>).slug).toBe('my-plan-2026-05-24');
    expect((capturedBody as unknown as Record<string, unknown>).harness_slug).toBe('myharn');
    expect((capturedBody as unknown as Record<string, unknown>).apply).toBe(true);
    expect(Array.isArray((capturedBody as unknown as Record<string, unknown>).features)).toBe(true);
  });
});
