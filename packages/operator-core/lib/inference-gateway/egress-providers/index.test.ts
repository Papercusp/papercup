/**
 * index.test.ts — the createEgressProvider factory (B-PROV, WI-288).
 * Run: cd packages/operator-core && npx vitest run lib/inference-gateway/egress-providers/index.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createEgressProvider } from './index';

describe('createEgressProvider', () => {
  it('builds a static provider from config.entries', async () => {
    const provider = createEgressProvider('static', { entries: [{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }] });
    expect(provider.name).toBe('static');
    const allocation = await provider.allocate('acct-a');
    expect(allocation).toMatchObject({ id: 'ip-1', accountId: 'acct-a' });
  });

  it('throws for static with no entries', () => {
    expect(() => createEgressProvider('static', {})).toThrow(/non-empty/);
  });

  it('builds a rayobyte provider (config optional — env-var defaults)', () => {
    const provider = createEgressProvider('rayobyte', { baseUrl: 'https://x.example.com' });
    expect(provider.name).toBe('rayobyte');
  });

  it('builds a brightdata provider', () => {
    const provider = createEgressProvider('brightdata');
    expect(provider.name).toBe('brightdata');
  });

  it('throws for an unknown provider name', () => {
    expect(() => createEgressProvider('nope' as never)).toThrow(/unknown provider/);
  });
});
