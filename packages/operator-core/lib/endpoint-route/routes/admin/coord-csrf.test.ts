/**
 * CSRF backstop coverage for the two VTL coord admin routes (WI-5249):
 * POST /admin/coord/:verb and POST /admin/coord-inbox-reply both admit
 * `unverified-loopback` (cookie-less desktop webview, EI-338), so the
 * `requireAllowedOriginOr403` guard is what refuses a browser cross-origin
 * POST. The sibling deploy-accounts tests mock the guard away; this file
 * pins the actual refusal + pass-through behavior.
 *
 * Pass-through is asserted via each handler's own early exit (404
 * unknown_verb / 400 missing_fields) so no downstream coord write fires.
 */
import { describe, expect, it } from 'vitest';
import coordRoutes from './coord';
import inboxReplyRoutes from './coord-inbox-reply';
import coordinationRoutes from './coordination';

const coordWrite = coordRoutes[0];
const inboxReply = inboxReplyRoutes[0];
const coordination = coordinationRoutes[0];

function post(path: string, origin: string | null, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin !== null) headers.origin = origin;
  return new Request(`http://127.0.0.1/api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('coord admin routes — CSRF backstop (requireAllowedOriginOr403)', () => {
  it('POST /admin/coord/:verb refuses a cross-origin browser POST', async () => {
    const req = post('/admin/coord/resolve', 'https://evil.example', { msg_id: 'x' });
    const res = (await coordWrite.handler(req as never, { params: { verb: 'resolve' } } as never)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin_blocked' });
  });

  it('POST /admin/coord-inbox-reply refuses a cross-origin browser POST', async () => {
    const req = post('/admin/coord-inbox-reply', 'https://evil.example', { askerId: 'a', text: 't' });
    const res = (await inboxReply.handler(req as never, {} as never)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin_blocked' });
  });

  it('allowed desktop-webview origins and no-Origin native fetches pass through', async () => {
    // coord/:verb — an unknown verb 404s AFTER the guard, proving pass-through.
    for (const origin of ['http://127.0.0.1:3055', 'tauri://tauri.localhost', null]) {
      const req = post('/admin/coord/nope', origin, {});
      const res = (await coordWrite.handler(req as never, { params: { verb: 'nope' } } as never)) as Response;
      expect(res.status, `coord/:verb origin=${origin}`).toBe(404);
    }
    // coord-inbox-reply — missing fields 400 AFTER the guard, same proof.
    for (const origin of ['http://localhost:3055', null]) {
      const req = post('/admin/coord-inbox-reply', origin, {});
      const res = (await inboxReply.handler(req as never, {} as never)) as Response;
      expect(res.status, `inbox-reply origin=${origin}`).toBe(400);
    }
  });
});

/**
 * WI-6486 — the coordination proxy joined the VTL set because the HUD's
 * conversation pane 403-blanked on the cookie-less desktop webview. Its
 * `unverified-loopback` admission rests entirely on the same CSRF backstop, and
 * this proxy reaches WRITE verbs (topics:create, conversations:post/answer/
 * resolve, coord:ask) — so if the guard is ever dropped from the dispatch, the
 * admission becomes a cross-origin write hole. These pin both halves.
 */
describe('coordination proxy — CSRF backstop (WI-6486)', () => {
  it('refuses a cross-origin browser POST', async () => {
    const req = post('/admin/coordination/sessions/list', 'https://evil.example', { owner: 'su-x' });
    const res = (await coordination.handler(req as never, {
      params: { group: 'sessions', verb: 'list' },
    } as never)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin_blocked' });
  });

  it('refuses a cross-origin POST to a WRITE verb too — not just the read', async () => {
    const req = post('/admin/coordination/topics/create', 'https://evil.example', { name: 'x' });
    const res = (await coordination.handler(req as never, {
      params: { group: 'topics', verb: 'create' },
    } as never)) as Response;
    expect(res.status).toBe(403);
  });

  it('lets desktop-webview origins and no-Origin native fetches through', async () => {
    // An unlisted verb 404s AFTER the guard, proving pass-through without
    // dispatching a real tool call.
    for (const origin of ['http://127.0.0.1:3055', 'tauri://tauri.localhost', null]) {
      const req = post('/admin/coordination/sessions/nope', origin, {});
      const res = (await coordination.handler(req as never, {
        params: { group: 'sessions', verb: 'nope' },
      } as never)) as Response;
      expect(res.status, `coordination origin=${origin}`).toBe(404);
    }
  });

  it('still exposes sessions:list — the lookup the HUD conversation depends on', async () => {
    // Guards the ALLOWED map itself: if `sessions.list` were dropped, the pane
    // would 404 instead of 403 and the symptom would look like a different bug.
    const req = post('/admin/coordination/sessions/list', null, { owner: 'su-x' });
    const res = (await coordination.handler(req as never, {
      params: { group: 'sessions', verb: 'list' },
    } as never)) as Response;
    expect(res.status).not.toBe(404);
  });
});
