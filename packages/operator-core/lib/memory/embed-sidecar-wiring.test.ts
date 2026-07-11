/**
 * P-004 (shared-embedding-sidecar-and-enrichment-2026-07-10): the one wiring
 * seam between the embedder cascade and the sidecar. Contracts:
 *  - explicit PAPERCUSP_EMBED_SIDECAR_URL wins and never triggers a spawn;
 *  - no URL + opt-in ensure() supplies the URL (lazy spawn/adopt);
 *  - a RESOLVED sidecar is REQUIRED — a dead one throws, no in-process
 *    failover (WI-4021, D-003 retired);
 *  - neither ⇒ pure in-process engine (no sidecar I/O).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSidecarAwareEmbedder, resolveProcessSidecarUrl } from './embed-sidecar-wiring';

const SIDECAR_VECTOR = [0.1, 0.2, 0.3];

async function startStub(): Promise<{ url: string; hits: number[]; close: () => Promise<void> }> {
  const hits: number[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push(1);
      const texts = (JSON.parse(raw) as { texts: string[] }).texts;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ vectors: texts.map(() => SIDECAR_VECTOR), dims: 3, runtime: 'stub', modelRev: 'stub' }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(() => r())) };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('resolveProcessSidecarUrl', () => {
  it('explicit URL wins without calling ensure (no spawn side effect)', async () => {
    let ensured = 0;
    const url = await resolveProcessSidecarUrl({
      resolveUrl: () => 'http://127.0.0.1:9999',
      ensure: async () => {
        ensured++;
        return null;
      },
    });
    expect(url).toBe('http://127.0.0.1:9999');
    expect(ensured).toBe(0);
  });

  it('falls through to ensure() when no explicit URL', async () => {
    expect(
      await resolveProcessSidecarUrl({ resolveUrl: () => null, ensure: async () => 'http://127.0.0.1:3384' }),
    ).toBe('http://127.0.0.1:3384');
    expect(await resolveProcessSidecarUrl({ resolveUrl: () => null, ensure: async () => null })).toBeNull();
  });
});

describe('buildSidecarAwareEmbedder', () => {
  it('embeds through the sidecar when a URL resolves', async () => {
    const stub = await startStub();
    closers.push(stub.close);
    const embed = await buildSidecarAwareEmbedder('gemma', 'query', {
      resolveUrl: () => stub.url,
      ensure: async () => null,
    });
    expect(await embed('hello')).toEqual(SIDECAR_VECTOR);
    expect(stub.hits.length).toBe(1);
  });

  it('dead sidecar URL ⇒ THROWS sidecar_required_unavailable — never loads an in-process model (WI-4021)', async () => {
    // The expected down-transition warn is the CORRECT behavior under test —
    // silence it so vitest-fail-on-console doesn't flag the intended log.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stub = await startStub();
      await stub.close(); // now a dead port
      const embed = await buildSidecarAwareEmbedder('gemma', 'document', {
        resolveUrl: () => null,
        ensure: async () => stub.url,
      });
      // A resolved-but-dead sidecar must reject loudly (D-003 retired): if this
      // ever silently falls back to a real in-process gemma load again, this
      // rejects-assertion fails instead of a 384-dim vector appearing.
      await expect(embed('x')).rejects.toThrow(/sidecar_required_unavailable/);
      expect(warnSpy).toHaveBeenCalled(); // exactly the down-transition log
    } finally {
      warnSpy.mockRestore();
    }
  }, 30_000);
});
