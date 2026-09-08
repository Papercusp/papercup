import { describe, expect, it } from 'vitest';
import { nativeProviderTraceOrigin } from './native-provider-trace';

describe('native provider trace resume', () => {
  const gateway = 'http://127.0.0.1:4321';
  const proxy = 'http://127.0.0.1:5432/api/pui-provider-debug';

  it('keeps the upstream when resume reads the rewritten registry', () => {
    const first = nativeProviderTraceOrigin(gateway, proxy);
    const resumed = nativeProviderTraceOrigin(`${proxy}/`, proxy, first);
    expect(`${resumed}/v1/messages`).toBe(`${gateway}/v1/messages`);
    expect(nativeProviderTraceOrigin(proxy, proxy, resumed)).toBe(gateway);
  });

  it('rejects a proxy target whose original upstream is unavailable or recursive', () => {
    expect(() => nativeProviderTraceOrigin(proxy, proxy)).toThrow('non-recursive upstream');
    expect(() => nativeProviderTraceOrigin(proxy, proxy, `${proxy}/v1`)).toThrow('non-recursive upstream');
  });

  it('honors a regenerated provider route, including a different route on the same host', () => {
    const newGateway = 'http://127.0.0.1:5432/api/provider';
    expect(nativeProviderTraceOrigin(newGateway, proxy, gateway)).toBe(newGateway);
  });
});
