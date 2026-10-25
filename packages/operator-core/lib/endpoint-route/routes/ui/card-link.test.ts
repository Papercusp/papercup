import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { _resetCardCorrelatorForTests, registerCard, resolveCardResponse } from '@papercusp/agent-mcp';
const authority = vi.hoisted(() => ({ workspace: 'workspace', allowed: true }));
vi.mock('../../session-or-local', () => ({ getSessionUserOrLocalDefaultAuthority: async () => authority.allowed
  ? { user: { workspace_id: authority.workspace } } : null }));
import route from './card-link';
afterEach(() => { _resetCardCorrelatorForTests(); authority.workspace = 'workspace'; authority.allowed = true; });
const get = (id: string) => (route as unknown as { handler(req: Request, ctx: unknown): Promise<Response> })
  .handler(new Request(`http://localhost/api/ui/cards/${id}/link`), { params: { id } });

describe('live private authentication redirect', () => {
  it('requires authenticated matching workspace and removes access after settlement', async () => {
    const card = registerCard({ workspaceId: 'workspace', runId: 'auth', spec: { prompt: 'Authenticate',
      dataSchema: z.object({ value: z.string() }), privateLink: 'https://auth.example/?code=PRIVATE',
    } });
    authority.allowed = false; expect((await get(card.correlationId)).status).toBe(401);
    authority.allowed = true; authority.workspace = 'foreign'; expect((await get(card.correlationId)).status).toBe(404);
    authority.workspace = 'workspace';
    const result = await get(card.correlationId);
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('https://auth.example/?code=PRIVATE');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await result.text()).toBe('');
    resolveCardResponse({ correlationId: card.correlationId, action: 'cancel', expectedWorkspaceId: 'workspace' });
    expect((await get(card.correlationId)).status).toBe(404);
  });
});
