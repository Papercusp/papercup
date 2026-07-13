/**
 * health-probe.test.ts — probeAllocationHealth (B-PROV, WI-288). Confirms the shared probe reuses
 * egress-probe.ts's fetchExitIp mechanics rather than a divergent copy.
 * Run: cd packages/operator-core && npx vitest run lib/inference-gateway/egress-providers/health-probe.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { probeAllocationHealth } from './health-probe';

const undiciStub = async () => ({ ProxyAgent: class {}, Socks5ProxyAgent: class {}, Agent: class {} }) as never;

describe('probeAllocationHealth', () => {
  it('returns no_egress_binding for an allocation with neither proxyUrl nor localAddress', async () => {
    const health = await probeAllocationHealth({});
    expect(health).toEqual({ reachable: false, error: 'no_egress_binding' });
  });

  it('returns reachable + exitIp on a successful echo', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ip: '5.5.5.5' }), { headers: { 'content-type': 'application/json' } }));
    const health = await probeAllocationHealth(
      { proxyUrl: 'http://10.0.0.1:3128' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, importUndici: undiciStub },
    );
    expect(health).toEqual({ reachable: true, exitIp: '5.5.5.5' });
  });

  it('returns reachable:false + error on a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const health = await probeAllocationHealth(
      { proxyUrl: 'http://10.0.0.1:3128' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, importUndici: undiciStub },
    );
    expect(health.reachable).toBe(false);
    expect(health.error).toMatch(/ECONNREFUSED/);
  });
});
