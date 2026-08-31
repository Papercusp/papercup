import { describe, expect, it } from 'vitest';
import type { RouteContext } from '../../define-route';
import { externalTurnRoute } from './external-turns';

const context = { params: { slug: 'portal', chatId: 'chat-1' } } as unknown as RouteContext;
const request = (body: unknown) => new Request('http://localhost/api/harness/portal/agent-chats/chat-1/external-turns', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('agent-chat external-turn route', () => {
  it('is loopback-only and does not share the messages route', () => {
    expect(externalTurnRoute).toMatchObject({
      method: 'POST', path: '/harness/:slug/agent-chats/:chatId/external-turns', auth: 'loopback',
    });
  });

  it('rejects browser-shaped or untrusted input before the writer', async () => {
    const response = await externalTurnRoute.handler(request({ role: 'user', content: 'hi' }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'source must be phone-livekit' });
  });
});
