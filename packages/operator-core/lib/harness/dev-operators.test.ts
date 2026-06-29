import { describe, it, expect, vi } from 'vitest';
import { resolveDevOperators, DEV_OPERATORS } from './dev-operators';

function versionResponse(sha: string): Response {
  return new Response(JSON.stringify({ sidecarSha: sha }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveDevOperators', () => {
  it('returns one entry per canonical env PLUS a trailing release entry', async () => {
    const fetchMock = vi.fn(async () => versionResponse('aaaaaaaa'));
    const { operators } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
    });
    expect(operators).toHaveLength(DEV_OPERATORS.length + 1);
    const envOps = operators.filter((o) => o.kind === 'env');
    expect(envOps).toHaveLength(DEV_OPERATORS.length);
    for (const op of envOps) {
      expect(op.origin).toBe(`http://127.0.0.1:${op.port}`);
    }
    const release = operators.find((o) => o.kind === 'release');
    expect(release).toBeTruthy();
    expect(release!.id).toBe('release');
    // Dev-box fallback: release origin = the prod :3070 green-release origin.
    expect(release!.origin).toBe('http://127.0.0.1:3070');
  });

  it('marks the self port reachable WITHOUT probing it', async () => {
    const fetchMock = vi.fn(async (_url: string) => versionResponse('bbbbbbbb'));
    const { operators, selfPort } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: 3270,
    });
    expect(selfPort).toBe(3270);
    const self = operators.find((o) => o.port === 3270)!;
    expect(self.isSelf).toBe(true);
    expect(self.reachable).toBe(true);
    // self (:3270) is never probed
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain(':3270/');
    }
  });

  it('reports reachable + sha for operators that answer /version', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes(':3070/')) return versionResponse('deadbeef');
      throw new Error('ECONNREFUSED');
    });
    const { operators } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
    });
    const prod = operators.find((o) => o.id === 'prod')!;
    expect(prod.reachable).toBe(true);
    expect(prod.sha).toBe('deadbeef');
    // release falls back to :3070 → also reachable here
    const release = operators.find((o) => o.kind === 'release')!;
    expect(release.reachable).toBe(true);
    // unreachable peers never throw out of resolve — just reachable:false
    const staging = operators.find((o) => o.id === 'staging')!;
    expect(staging.reachable).toBe(false);
    expect(staging.sha).toBeNull();
  });

  it('treats a non-ok or aborted probe as unreachable (never throws)', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 502 }));
    const { operators } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
      timeoutMs: 50,
    });
    expect(operators.every((o) => !o.reachable)).toBe(true);
  });
});
