import { describe, expect, it, vi } from 'vitest';
import { sendGoogleGmailDraft } from './google-gmail';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const ORIGIN = 'https://gmail.test';
const SEAM = { apiOrigin: ORIGIN } as const;

describe('sendGoogleGmailDraft', () => {
  it('sends the existing draft by id and returns the resulting message', async () => {
    const seen: { url: string; method?: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(request),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ id: 'msg-1', threadId: 'thr-1' });
    }) as unknown as typeof fetch;

    const result = await sendGoogleGmailDraft('token', 'draft-1', { fetch: fetchImpl, ...SEAM });

    expect(result).toEqual({ messageId: 'msg-1', threadId: 'thr-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe(`${ORIGIN}/gmail/v1/users/me/drafts/send`);
    expect(seen[0].body).toEqual({ id: 'draft-1' });
  });

  it('does NOT re-encode the message — the reviewed bytes are what ship', async () => {
    // This is the property that makes this the approved-artifact send path. If a
    // `raw` ever appears here, the function has started composing a NEW message
    // and the thing sent is no longer the thing the human reviewed.
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_r: string | URL | Request, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return json({ id: 'msg-2', threadId: 'thr-2' });
    }) as unknown as typeof fetch;

    await sendGoogleGmailDraft('token', 'draft-2', { fetch: fetchImpl, ...SEAM });

    expect(body).toBeDefined();
    expect(body).not.toHaveProperty('raw');
    expect(body).not.toHaveProperty('message');
    expect(Object.keys(body as object)).toEqual(['id']);
  });

  it('url-encodes nothing into the path — the draft id travels in the body', async () => {
    // drafts/send takes the id as a body field, unlike the drafts/{id} routes.
    // An id spliced into the path would silently 404 for ids containing '/'.
    const fetchImpl = vi.fn(async () => json({ id: 'm', threadId: 't' })) as unknown as typeof fetch;
    await sendGoogleGmailDraft('token', 'r-708/811', { fetch: fetchImpl, ...SEAM });
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe(`${ORIGIN}/gmail/v1/users/me/drafts/send`);
  });

  it('trims the draft id and token', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_r: string | URL | Request, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return json({ id: 'm', threadId: 't' });
    }) as unknown as typeof fetch;
    await sendGoogleGmailDraft('  token  ', '  draft-3  ', { fetch: fetchImpl, ...SEAM });
    expect(body).toEqual({ id: 'draft-3' });
  });

  it('refuses an empty access token without calling Gmail', async () => {
    const fetchImpl = vi.fn(async () => json({})) as unknown as typeof fetch;
    await expect(sendGoogleGmailDraft('   ', 'draft-1', { fetch: fetchImpl, ...SEAM })).rejects.toThrow(
      'google_gmail_access_token_required',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an empty draft id without calling Gmail', async () => {
    const fetchImpl = vi.fn(async () => json({})) as unknown as typeof fetch;
    await expect(sendGoogleGmailDraft('token', '   ', { fetch: fetchImpl, ...SEAM })).rejects.toThrow(
      'google_gmail_draft_id_required',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a 2xx that carries no message id', async () => {
    // The shape that would otherwise let a caller record a send that may not
    // have happened: HTTP said fine, Gmail named nothing.
    const fetchImpl = vi.fn(async () => json({ threadId: 'thr-1' })) as unknown as typeof fetch;
    await expect(sendGoogleGmailDraft('token', 'draft-1', { fetch: fetchImpl, ...SEAM })).rejects.toThrow(
      'google_gmail_draft_send_response_invalid',
    );
  });

  it('refuses a 2xx that carries no thread id', async () => {
    const fetchImpl = vi.fn(async () => json({ id: 'msg-1' })) as unknown as typeof fetch;
    await expect(sendGoogleGmailDraft('token', 'draft-1', { fetch: fetchImpl, ...SEAM })).rejects.toThrow(
      'google_gmail_draft_send_response_invalid',
    );
  });

  it('propagates a Gmail error rather than reporting a send', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { message: 'draft not found' } }, 404),
    ) as unknown as typeof fetch;
    await expect(sendGoogleGmailDraft('token', 'missing', { fetch: fetchImpl, ...SEAM })).rejects.toThrow();
  });
});
