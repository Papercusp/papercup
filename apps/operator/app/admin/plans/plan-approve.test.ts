// @vitest-environment jsdom
/**
 * Unit coverage for the approve / demote write helpers (plans-api).
 *
 * These flip the frontmatter `status:` line via a compare-and-swap
 * `set-content` write (mirroring `rejectDraftPlan`). We mock `fetch` so
 * the real exported functions run end-to-end — verifying the regex flip,
 * the no-match guard, and the CAS payload (content + expectedHash +
 * optional harness_slug) actually sent to the server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { approvePlan, demotePlanToDraft } from './plans-api';

const HASH = 'hash-abc';

interface PostCall {
  slug?: string;
  content?: string;
  expectedHash?: string;
  harness_slug?: string;
}

let getRaw: string;
let postCalls: PostCall[];

const fm = (status: string) =>
  `---\ntitle: P\nslug: p\nstatus: ${status}\ncreated: 2026-05-30\nupdated: 2026-05-30\n---\n\n# Body\n`;

beforeEach(() => {
  getRaw = '';
  postCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('/api/admin/plans/get')) {
        return { ok: true, json: async () => ({ slug: 'p', raw: getRaw, contentHash: HASH }) } as Response;
      }
      if (method === 'POST' && url.includes('/api/admin/plans/set-content')) {
        postCalls.push(JSON.parse(init!.body!) as PostCall);
        return { ok: true, text: async () => JSON.stringify({ ok: true, contentHash: 'hash-new' }) } as Response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('approvePlan', () => {
  it('flips status: draft → ready and sends the CAS payload', async () => {
    getRaw = fm('draft');
    const r = await approvePlan('p');
    expect(r).toEqual({ ok: true });
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].slug).toBe('p');
    expect(postCalls[0].expectedHash).toBe(HASH);
    expect(postCalls[0].content).toContain('status: ready');
    expect(postCalls[0].content).not.toContain('status: draft');
  });

  it('threads harness_slug through when provided', async () => {
    getRaw = fm('draft');
    await approvePlan('p', 'sheets');
    expect(postCalls[0].harness_slug).toBe('sheets');
  });

  it('refuses a non-draft plan without writing', async () => {
    getRaw = fm('shipped');
    const r = await approvePlan('p');
    expect(r).toEqual({ ok: false, error: 'status_not_draft' });
    expect(postCalls).toHaveLength(0);
  });

  it('only flips the frontmatter status line, leaving body prose intact', async () => {
    getRaw = `---\nstatus: draft\n---\n\nThe old status: draft text stays.\n`;
    await approvePlan('p');
    // first (frontmatter) line flipped; prose "status: draft" untouched
    expect(postCalls[0].content).toBe(`---\nstatus: ready\n---\n\nThe old status: draft text stays.\n`);
  });
});

describe('demotePlanToDraft', () => {
  it('flips status: ready → draft', async () => {
    getRaw = fm('ready');
    const r = await demotePlanToDraft('p');
    expect(r).toEqual({ ok: true });
    expect(postCalls[0].content).toContain('status: draft');
    expect(postCalls[0].content).not.toContain('status: ready');
  });

  it('also demotes a legacy active plan', async () => {
    getRaw = fm('active');
    await demotePlanToDraft('p');
    expect(postCalls[0].content).toContain('status: draft');
    expect(postCalls[0].content).not.toContain('status: active');
  });

  it('refuses a draft plan without writing', async () => {
    getRaw = fm('draft');
    const r = await demotePlanToDraft('p');
    expect(r).toEqual({ ok: false, error: 'status_not_ready' });
    expect(postCalls).toHaveLength(0);
  });
});
