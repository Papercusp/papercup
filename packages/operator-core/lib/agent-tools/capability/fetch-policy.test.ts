import type { Dispatcher } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import {
  CapabilityFetchPolicyError,
  fetchWithCapabilityPolicy,
  isNonPublicFetchAddress,
  type CapabilityFetchPolicyDeps,
  type ResolvedFetchAddress,
} from './fetch-policy';
import type { OperationBoundaryProfile } from './boundary-profile';

const confined: OperationBoundaryProfile = { kind: 'confined', reason: 'autonomous-caller' };
const trusted: OperationBoundaryProfile = { kind: 'trusted', reason: 'superuser' };
const signal = new AbortController().signal;
const publicAddress: ResolvedFetchAddress = { address: '93.184.216.34', family: 4 };

function deps(
  lookup: CapabilityFetchPolicyDeps['lookup'],
  fetch: CapabilityFetchPolicyDeps['fetch'],
  selected: ResolvedFetchAddress[] = [],
): CapabilityFetchPolicyDeps {
  return {
    lookup,
    fetch,
    createPinnedDispatcher(address) {
      selected.push(address);
      return {
        dispatcher: {} as Dispatcher,
        close: async () => undefined,
      };
    },
  };
}

describe('isNonPublicFetchAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('classifies %s as non-public', (address) => {
    expect(isNonPublicFetchAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])(
    'classifies %s as public',
    (address) => {
      expect(isNonPublicFetchAddress(address)).toBe(false);
    },
  );
});

describe('fetchWithCapabilityPolicy', () => {
  it('rejects a private destination before any fetch effect', async () => {
    const effect = vi.fn(async () => new Response('should not run'));
    await expect(
      fetchWithCapabilityPolicy(
        { url: 'http://127.0.0.1:9999/private', method: 'GET', signal, profile: confined },
        deps(async () => [{ address: '127.0.0.1', family: 4 }], effect),
      ),
    ).rejects.toMatchObject({ code: 'confined_private_address' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects a mixed DNS answer set before connecting to the public member', async () => {
    const effect = vi.fn(async () => new Response('should not run'));
    await expect(
      fetchWithCapabilityPolicy(
        { url: 'https://mixed.example/data', method: 'GET', signal, profile: confined },
        deps(
          async () => [publicAddress, { address: '169.254.169.254', family: 4 }],
          effect,
        ),
      ),
    ).rejects.toMatchObject({ code: 'confined_private_address' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('pins a permitted public request to the validated address', async () => {
    const selected: ResolvedFetchAddress[] = [];
    const effect = vi.fn(async () => new Response('ok', { status: 200 }));
    const result = await fetchWithCapabilityPolicy(
      { url: 'https://example.com/data', method: 'GET', signal, profile: confined },
      deps(async () => [publicAddress], effect, selected),
    );
    expect(selected).toEqual([publicAddress]);
    expect(effect).toHaveBeenCalledWith(
      'https://example.com/data',
      expect.objectContaining({ redirect: 'manual', dispatcher: expect.anything() }),
    );
    await result.release();
  });

  it('validates a redirect target before the redirected network effect', async () => {
    const effect = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://metadata.internal/latest' },
    }));
    await expect(
      fetchWithCapabilityPolicy(
        { url: 'https://public.example/start', method: 'GET', signal, profile: confined },
        deps(
          async (host) => host === 'public.example'
            ? [publicAddress]
            : [{ address: '169.254.169.254', family: 4 }],
          effect,
        ),
      ),
    ).rejects.toMatchObject({ code: 'confined_private_address' });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('strips credentials before a trusted cross-origin redirect', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const effect: CapabilityFetchPolicyDeps['fetch'] = async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://other.example/final' } })
        : new Response('ok');
    };
    const result = await fetchWithCapabilityPolicy(
      {
        url: 'https://api.example/start',
        method: 'GET',
        headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
        signal,
        profile: trusted,
      },
      deps(async () => [publicAddress], effect),
    );
    expect(calls[0]!.headers.authorization).toBe('Bearer secret');
    expect(calls[1]!.headers).not.toHaveProperty('authorization');
    expect(calls[1]!.headers.accept).toBe('application/json');
    await result.release();
  });

  it('refuses mutating methods and credential headers for confined callers before fetch', async () => {
    const effect = vi.fn(async () => new Response('should not run'));
    await expect(
      fetchWithCapabilityPolicy(
        { url: 'https://example.com', method: 'POST', body: '{}', signal, profile: confined },
        deps(async () => [publicAddress], effect),
      ),
    ).rejects.toMatchObject({ code: 'confined_method_forbidden' });
    await expect(
      fetchWithCapabilityPolicy(
        {
          url: 'https://example.com',
          method: 'GET',
          headers: { Authorization: 'Bearer secret' },
          signal,
          profile: confined,
        },
        deps(async () => [publicAddress], effect),
      ),
    ).rejects.toMatchObject({ code: 'confined_credentials_forbidden' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('preserves trusted local integration POSTs', async () => {
    const effect = vi.fn(async () => new Response('local-ok'));
    const result = await fetchWithCapabilityPolicy(
      {
        url: 'http://127.0.0.1:11434/api/generate',
        method: 'POST',
        headers: { Authorization: 'Bearer local-token', 'Content-Type': 'application/json' },
        body: '{}',
        signal,
        profile: trusted,
      },
      deps(async () => [{ address: '127.0.0.1', family: 4 }], effect),
    );
    expect(effect).toHaveBeenCalledTimes(1);
    await result.release();
  });
});
