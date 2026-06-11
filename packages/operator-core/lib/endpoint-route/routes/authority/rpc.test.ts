/**
 * Unit tests for the POST /api/authority/rpc route's parse-guard paths. The full
 * dispatch + verifyIsAuthority guard are covered by the authority-op-registry +
 * loopback + two-instance tests (this route is a thin HTTP wrapper around the
 * tested handleAuthorityRpc).
 */
import { describe, expect, it } from 'vitest';
import route from './rpc';

// The defineTool route exposes its handler; call it with a minimal Request-like.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = (route as any).handler as (req: { json: () => Promise<unknown> }) => Promise<Response>;

describe('POST /api/authority/rpc — parse guards', () => {
  it('is registered with method POST + path /authority/rpc + public auth', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = route as any;
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/authority/rpc');
    expect(r.auth).toBe('public');
  });

  it('rejects invalid JSON with 400 (does not reach the authority resolution)', async () => {
    const res = await handler({ json: async () => { throw new Error('bad json'); } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_json' });
  });

  it('rejects an envelope missing harnessSlug/kind with 400', async () => {
    const res = await handler({ json: async () => ({ payload: {} }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_envelope' });
  });

  it('refuses an unsigned op as unauthenticated when AUTHORITY_RPC_SIGNED is on (EI-322)', async () => {
    // The flag defaults ON (no override store in a unit test → default true). A
    // well-formed but UNSIGNED envelope for a registered kind reaches verifyCaller
    // (after the unknown_kind guard, before verifyIsAuthority) and is refused —
    // so this never touches lockAuthorityFor / PG.
    const { registerAuthorityOp, __resetAuthorityOpsForTests } = await import(
      '../../../authority/authority-op-registry'
    );
    __resetAuthorityOpsForTests();
    registerAuthorityOp('work-item.claim.acquire', async () => ({ granted: true }));
    try {
      const res = await handler({
        json: async () => ({ harnessSlug: 'papercup', kind: 'work-item.claim.acquire', payload: { workspaceId: 'ws' } }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe('unauthenticated');
    } finally {
      __resetAuthorityOpsForTests();
    }
  });
});
