/**
 * Direct route coverage for Settings → Identities (identities-v1 P-011).
 *
 * The service suite pins stack semantics; this suite pins the production door:
 * registry reachability, loopback auth, wire-body forwarding, launch-overlay
 * replay, and sync invalidation after a successful write.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  isLoopbackRequest: vi.fn(() => true),
  readLaunchSpec: vi.fn(async (): Promise<unknown> => ({ launch: true })),
  parseLaunchSpec: vi.fn(() => ({ autoMode: true, drainMode: false, loopArmed: true })),
  mutate: vi.fn(async (_input: unknown) => ({ ok: true, changed: true })),
  modeSection: vi.fn(() => 'mode-section'),
  invalidate: vi.fn(async (_name: string) => {}),
}));

vi.mock('../../../superuser-token', () => ({ isLoopbackRequest: H.isLoopbackRequest }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../adv-sessions', () => ({ readSuLaunchSpecByOwner: H.readLaunchSpec }));
vi.mock('../../../su-persona-render', () => ({ parseSuLaunchSpecRecord: H.parseLaunchSpec }));
vi.mock('../../../identity-management', () => ({ mutateIdentityStack: H.mutate }));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: H.invalidate }));
vi.mock('./bootstrap-su', () => ({ composeModePromptSection: H.modeSection }));

async function post(body: unknown, headers: HeadersInit = { 'content-type': 'application/json' }) {
  const mod = await import('./identity-management');
  const route = mod.default as unknown as { handler: (request: Request) => Promise<Response> };
  return route.handler(
    new Request('http://operator.test/agent-mcp/identity-management', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  H.isLoopbackRequest.mockReturnValue(true);
  H.readLaunchSpec.mockResolvedValue({ launch: true });
  H.parseLaunchSpec.mockReturnValue({ autoMode: true, drainMode: false, loopArmed: true });
  H.mutate.mockResolvedValue({ ok: true, changed: true });
});

describe('POST /agent-mcp/identity-management', () => {
  it('is reachable through the production route registry', async () => {
    const mod = await import('./identity-management');
    const route = mod.default as unknown as { method: string; path: string };
    expect(route).toMatchObject({ method: 'POST', path: '/agent-mcp/identity-management' });

    // Keep this hermetic: importing the whole 500-route registry under the
    // route's intentionally-narrow dependency mocks couples this test to every
    // unrelated export in adv-sessions. The canonical index source is the
    // registration truth and this pair pins both required wiring sites.
    const index = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
    expect(index).toContain("import agentMcp_identityManagement from './agent-mcp/identity-management';");
    expect(index).toContain('...flatten(agentMcp_identityManagement as AnyRoute),');
  });

  it('forwards the reviewed mutation and current mode overlay, then invalidates the surface', async () => {
    const response = await post({
      ownerId: '  su-target  ',
      action: 'switch',
      identityId: 'research-steward',
      slot: 'domain',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, changed: true });
    expect(H.readLaunchSpec).toHaveBeenCalledWith('su-target');
    expect(H.modeSection).toHaveBeenCalledWith({ autoMode: true, drainMode: false, loopArmed: true });
    expect(H.mutate).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      ownerId: 'su-target',
      action: 'switch',
      identityId: 'research-steward',
      slot: 'domain',
      operatorBaseUrl: 'http://operator.test',
      modeSection: 'mode-section',
    });
    expect(H.invalidate).toHaveBeenCalledWith('identities.surface');
  });

  it('rejects non-loopback, malformed JSON, and an unknown action before mutation', async () => {
    H.isLoopbackRequest.mockReturnValue(false);
    expect((await post({ ownerId: 'su-target', action: 'switch' })).status).toBe(403);

    H.isLoopbackRequest.mockReturnValue(true);
    expect((await post('{')).status).toBe(400);
    expect((await post({ ownerId: 'su-target', action: 'rebind' })).status).toBe(400);
    expect(H.mutate).not.toHaveBeenCalled();
  });

  it('surfaces an immutable/missing launch spec and a mutation refusal without invalidating', async () => {
    H.parseLaunchSpec.mockReturnValueOnce(null);
    const missing = await post({ ownerId: 'su-target', action: 'rollback' });
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({
      ok: false,
      error: 'The selected session has no mutable launch specification.',
    });

    H.mutate.mockRejectedValueOnce(new Error('concurrent identity change'));
    const refused = await post({ ownerId: 'su-target', action: 'rollback' });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ ok: false, error: 'concurrent identity change' });
    expect(H.invalidate).not.toHaveBeenCalled();
  });
});
