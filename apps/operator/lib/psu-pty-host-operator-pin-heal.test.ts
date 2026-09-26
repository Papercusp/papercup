/**
 * healDeadOperatorPin — the in-place-respawn heal for a dead operator pin
 * (EI-24091823697677465).
 *
 * Measured 2026-09-23: a session launched from a staging console inherited
 * PAPERCUSP_OPERATOR_URL=http://localhost:3170 and carried it through every in-place
 * carry-respawn, because nothing re-checked the pin between respawns. Each staging
 * restart then took the session's MCP tools and its owner-directive capture down.
 *
 * The rule under test is deliberately narrow, and both halves matter:
 *   - a managed pin that REFUSES the connection is replaced by a healthy local proxy;
 *   - an explicit pin stays authoritative even when it refuses connections;
 *   - a pin that answers at all — even with an error, even slowly — is ALIVE and stays
 *     authoritative, so a live staging session is never silently moved to green.
 *
 * The cases use real loopback sockets for the pin, so the refusal is recognised from
 * the error shape Node's fetch actually produces, not from a hand-built stand-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { healDeadOperatorPin } from '../scripts/psu-pty-host.mjs';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      // The "slow" stub never answers; drop its held socket so close() can finish.
      s.closeAllConnections();
      return new Promise<void>((r) => s.close(() => r()));
    }),
  );
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

const healthyProxy = () =>
  serve((req, res) => {
    res.writeHead(req.url === '/api/health' ? 200 : 404);
    res.end('ok');
  });

/** A loopback port with nothing listening: bind an ephemeral port, then free it. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('healDeadOperatorPin (EI-24091823697677465)', () => {
  it('a managed pin that REFUSES the connection is replaced by the healthy proxy', async () => {
    const proxyPort = await healthyProxy();
    const pinned = `http://localhost:${await deadPort()}`;
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: pinned,
      PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };

    const healed = await healDeadOperatorPin(env);

    expect(healed).toEqual({ from: pinned, to: `http://127.0.0.1:${proxyPort}` });
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(`http://127.0.0.1:${proxyPort}`);
    // Now a launcher decision, so a later wake may rediscover instead of treating it
    // as the caller's fixed pin.
    expect(env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('psu-launcher');
  });

  it.each([undefined, 'unknown'])('preserves a refused explicit pin with provenance %s', async (provenance) => {
    const proxyPort = await healthyProxy();
    const pinned = `http://127.0.0.1:${await deadPort()}`;
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: pinned,
      PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
      ...(provenance ? { PAPERCUSP_OPERATOR_URL_PROVENANCE: provenance } : {}),
    };
    const before = { ...env };
    expect(await healDeadOperatorPin(env)).toBeNull();
    expect(env).toEqual(before);
  });

  it('a pin that ANSWERS with an error is alive and stays', async () => {
    const proxyPort = await healthyProxy();
    const pinPort = await serve((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${pinPort}`,
      PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };

    expect(await healDeadOperatorPin(env)).toBeNull();
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(`http://127.0.0.1:${pinPort}`);
    expect(env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('psu-launcher');
  });

  it('a pin that is merely SLOW (times out) is alive and stays', async () => {
    const proxyPort = await healthyProxy();
    const pinPort = await serve(() => {
      /* never answers */
    });
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${pinPort}`,
      PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };

    expect(await healDeadOperatorPin(env, { timeoutMs: 200 })).toBeNull();
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(`http://127.0.0.1:${pinPort}`);
  });

  it('a dead pin stays when the proxy is ALSO dead — never swap to an unverified address', async () => {
    const pinned = `http://127.0.0.1:${await deadPort()}`;
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: pinned,
      PAPERCUSP_MCP_PROXY_PORT: String(await deadPort()),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };

    expect(await healDeadOperatorPin(env)).toBeNull();
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(pinned);
  });

  it('never probes a pin to ANOTHER host, a pin that already IS the proxy, an opted-out proxy, or no pin', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'));
    const cases: Array<Record<string, string>> = [
      { PAPERCUSP_OPERATOR_URL: 'http://operator.example:3170' },
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071' },
      { PAPERCUSP_OPERATOR_URL: 'http://localhost:3170', PAPERCUSP_MCP_PROXY: '0' },
      {},
    ];
    for (const env of cases) {
      env.PAPERCUSP_OPERATOR_URL_PROVENANCE = 'psu-launcher';
      const before = { ...env };
      expect(await healDeadOperatorPin(env, { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
      expect(env).toEqual(before);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
