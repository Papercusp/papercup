/**
 * postCardResponse client helper tests — fetch-mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { postCardResponse } from './post-card-response';

describe('postCardResponse', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    fetchSpy.mockReset();
  });

  function okResp(body: object) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  function errResp(status: number, body: object) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('submit happy-path: POSTs body and returns {ok:true}', async () => {
    fetchSpy.mockResolvedValueOnce(okResp({ ok: true }));
    const r = await postCardResponse('conv-1', {
      correlationId: 'cid-1',
      workspaceId: 'ws-A',
      action: 'submit',
      payload: { picks: ['a'] },
    });
    expect(r).toEqual({ ok: true, status: 200 });
    const args = fetchSpy.mock.calls[0];
    expect(args[0]).toContain('/api/operator/conversations/conv-1/card-response');
    expect(args[1].method).toBe('POST');
    expect(JSON.parse(args[1].body as string)).toEqual({
      correlationId: 'cid-1',
      workspaceId: 'ws-A',
      action: 'submit',
      payload: { picks: ['a'] },
    });
  });

  it('encodes the conversation id', async () => {
    fetchSpy.mockResolvedValueOnce(okResp({ ok: true }));
    await postCardResponse('conv with/space', {
      correlationId: 'c',
      workspaceId: 'w',
      action: 'cancel',
    });
    expect(fetchSpy.mock.calls[0][0]).toContain('conv%20with%2Fspace');
  });

  it('error: returns ok=false with status + parsed error', async () => {
    fetchSpy.mockResolvedValueOnce(
      errResp(400, { error: 'payload does not match dataSchema', details: [{ path: ['picks'] }] }),
    );
    const r = await postCardResponse('conv-1', {
      correlationId: 'c',
      workspaceId: 'w',
      action: 'submit',
      payload: { picks: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/dataSchema/);
    expect(r.details).toBeDefined();
  });

  it('401: returns unauthorized cleanly even with empty body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));
    const r = await postCardResponse('conv-1', {
      correlationId: 'c',
      workspaceId: 'w',
      action: 'submit',
      payload: { picks: ['a'] },
    });
    expect(r).toEqual({ ok: false, status: 401, error: undefined, details: undefined });
  });
});

describe('postRunCancel', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => fetchSpy.mockReset());

  it('POSTs runId + workspaceId to /run-cancel and returns ok:true', async () => {
    const { postRunCancel } = await import('./post-card-response');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await postRunCancel('conv-1', { runId: 'r-1', workspaceId: 'ws-A' });
    expect(r).toEqual({ ok: true, status: 200 });
    const args = fetchSpy.mock.calls[0];
    expect(args[0]).toContain('/api/operator/conversations/conv-1/run-cancel');
    expect(JSON.parse(args[1].body as string)).toEqual({
      runId: 'r-1',
      workspaceId: 'ws-A',
    });
  });

  it('returns ok:false with parsed error on 404', async () => {
    const { postRunCancel } = await import('./post-card-response');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'run not found in workspace' }), { status: 404 }),
    );
    const r = await postRunCancel('conv-1', { runId: 'r-1', workspaceId: 'w' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.error).toMatch(/run not found/);
  });
});
