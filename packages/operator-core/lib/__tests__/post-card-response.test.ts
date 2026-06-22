/**
 * post-card-response.test.ts — Plan 1 P-023: operator chat card
 * submit/decline/cancel client module.
 *
 * `postCardResponse` and `postRunCancel` are the client-side wrappers used
 * by the operator chat UI for the human-in-the-loop card flow:
 *   - submit: accept a card answer
 *   - decline: reject a card
 *   - cancel: abort all pending cards for a run
 *
 * Tests confirm correct URL construction, HTTP method, body serialization,
 * success shape, and two error paths (JSON + non-JSON body).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { postCardResponse, postRunCancel } from '../post-card-response';

function okFetch(status = 200) {
  return vi.fn(async () => new Response('{}', { status }));
}
function errorFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}
function nonJsonFetch(status: number) {
  return vi.fn(async () => new Response('Internal Server Error', { status, headers: { 'content-type': 'text/plain' } }));
}

afterEach(() => vi.unstubAllGlobals());

// ─── postCardResponse ─────────────────────────────────────────────────────────

describe('postCardResponse', () => {
  it('POSTs to /api/operator/conversations/:id/card-response', async () => {
    const fetch = okFetch();
    vi.stubGlobal('fetch', fetch);

    await postCardResponse('conv-1', {
      correlationId: 'corr-1',
      workspaceId: 'ws-1',
      action: 'submit',
    });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/operator/conversations/conv-1/card-response');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
  });

  it('encodes the conversation id in the URL', async () => {
    const fetch = okFetch();
    vi.stubGlobal('fetch', fetch);

    await postCardResponse('conv with spaces', {
      correlationId: 'c',
      workspaceId: 'w',
      action: 'decline',
    });

    const [url] = fetch.mock.calls[0] as unknown as [string];
    expect(url).toContain('conv%20with%20spaces');
  });

  it('sends action + correlationId + workspaceId in the body', async () => {
    const fetch = okFetch();
    vi.stubGlobal('fetch', fetch);

    await postCardResponse('cid', {
      correlationId: 'corr-xyz',
      workspaceId: 'ws-abc',
      action: 'cancel',
      reason: 'user cancelled',
    });

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.action).toBe('cancel');
    expect(body.correlationId).toBe('corr-xyz');
    expect(body.reason).toBe('user cancelled');
  });

  it('returns ok:true + status on 200', async () => {
    vi.stubGlobal('fetch', okFetch(200));
    const r = await postCardResponse('c', { correlationId: 'x', workspaceId: 'w', action: 'submit' });
    expect(r).toEqual({ ok: true, status: 200 });
  });

  it('returns ok:false + error when response has JSON error body', async () => {
    vi.stubGlobal('fetch', errorFetch(400, { error: 'card expired', details: { code: 42 } }));
    const r = await postCardResponse('c', { correlationId: 'x', workspaceId: 'w', action: 'submit' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toBe('card expired');
    expect((r.details as any)?.code).toBe(42);
  });

  it('returns ok:false without crashing on non-JSON error body', async () => {
    vi.stubGlobal('fetch', nonJsonFetch(500));
    const r = await postCardResponse('c', { correlationId: 'x', workspaceId: 'w', action: 'submit' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toBeUndefined();
  });
});

// ─── postRunCancel ────────────────────────────────────────────────────────────

describe('postRunCancel', () => {
  it('POSTs to /api/operator/conversations/:id/run-cancel', async () => {
    const fetch = okFetch();
    vi.stubGlobal('fetch', fetch);

    await postRunCancel('conv-2', { runId: 'run-1', workspaceId: 'ws-1' });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/operator/conversations/conv-2/run-cancel');
    expect(init.method).toBe('POST');
  });

  it('sends runId + workspaceId in the body', async () => {
    const fetch = okFetch();
    vi.stubGlobal('fetch', fetch);

    await postRunCancel('conv-3', { runId: 'run-99', workspaceId: 'ws-xyz' });

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.runId).toBe('run-99');
    expect(body.workspaceId).toBe('ws-xyz');
  });

  it('returns ok:true on success', async () => {
    vi.stubGlobal('fetch', okFetch(200));
    const r = await postRunCancel('c', { runId: 'r', workspaceId: 'w' });
    expect(r.ok).toBe(true);
  });

  it('returns ok:false on error', async () => {
    vi.stubGlobal('fetch', errorFetch(404, { error: 'run not found' }));
    const r = await postRunCancel('c', { runId: 'r', workspaceId: 'w' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('run not found');
  });
});
