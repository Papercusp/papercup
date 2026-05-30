// @vitest-environment jsdom
/**
 * Unit coverage for the approve / demote UI helpers (plans-api).
 *
 * These are thin wrappers over the first-class `plans:set-plan-status`
 * verb (the same verb agents call) — the frontmatter flip + CAS now live
 * server-side (covered by lib/agent-tools/plans/__tests__/set-plan-status).
 * Here we mock `fetch` and assert the wrappers hit the right verb with
 * the right payload (target status, transition guard, harness routing)
 * and map the verb's `{ ok, code }` result to the UI's `{ ok, error }`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { approvePlan, demotePlanToDraft } from './plans-api';

interface PostCall {
  slug?: string;
  status?: string;
  expectedCurrent?: string;
  harness_slug?: string;
}

let postCalls: Array<{ verb: string; body: PostCall }>;
let nextResponse: { ok: boolean; code?: string };

beforeEach(() => {
  postCalls = [];
  nextResponse = { ok: true };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const verb = url.split('/api/admin/plans/')[1]?.split('?')[0] ?? '';
      postCalls.push({ verb, body: JSON.parse(init!.body!) as PostCall });
      return { ok: true, text: async () => JSON.stringify(nextResponse) } as Response;
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('approvePlan', () => {
  it('calls set-plan-status with status:ready guarded on draft', async () => {
    const r = await approvePlan('p');
    expect(r).toEqual({ ok: true });
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].verb).toBe('set-plan-status');
    expect(postCalls[0].body).toMatchObject({ slug: 'p', status: 'ready', expectedCurrent: 'draft' });
    expect(postCalls[0].body.harness_slug).toBeUndefined();
  });

  it('threads harness_slug when provided', async () => {
    await approvePlan('p', 'sheets');
    expect(postCalls[0].body.harness_slug).toBe('sheets');
  });

  it('maps a verb failure code to the error field', async () => {
    nextResponse = { ok: false, code: 'unexpected_status' };
    const r = await approvePlan('p');
    expect(r).toEqual({ ok: false, error: 'unexpected_status' });
  });
});

describe('demotePlanToDraft', () => {
  it('calls set-plan-status with status:draft, unguarded', async () => {
    const r = await demotePlanToDraft('p');
    expect(r).toEqual({ ok: true });
    expect(postCalls[0].verb).toBe('set-plan-status');
    expect(postCalls[0].body).toMatchObject({ slug: 'p', status: 'draft' });
    expect(postCalls[0].body.expectedCurrent).toBeUndefined();
  });

  it('threads harness_slug when provided', async () => {
    await demotePlanToDraft('p', 'sheets');
    expect(postCalls[0].body.harness_slug).toBe('sheets');
  });
});
