import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./authority/lock-authority', () => ({ routeToAuthorityForHive: vi.fn() }));
vi.mock('./work-item-claim-authority', () => ({ setWorkItemClaimAuthority: vi.fn() }));

import { SwarmWorkItemClaimAuthority, installSwarmWorkItemClaimAuthority } from './work-item-claim-authority-swarm';
import { routeToAuthorityForHive } from './authority/lock-authority';
import { setWorkItemClaimAuthority } from './work-item-claim-authority';

const mockedRoute = vi.mocked(routeToAuthorityForHive);
const mockedSet = vi.mocked(setWorkItemClaimAuthority);

describe('SwarmWorkItemClaimAuthority', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isSelf is true when the route resolves via the local authority', async () => {
    mockedRoute.mockResolvedValue({ via: 'local-authority', value: true } as never);
    expect(await new SwarmWorkItemClaimAuthority().isSelf('hive-1')).toBe(true);
  });

  it('isSelf is false when a remote peer is the authority', async () => {
    mockedRoute.mockResolvedValue({ via: 'remote', value: true } as never);
    expect(await new SwarmWorkItemClaimAuthority().isSelf('hive-1')).toBe(false);
  });

  it('route returns the authority op value', async () => {
    mockedRoute.mockResolvedValue({ via: 'local-authority', value: 'OK' } as never);
    const r = await new SwarmWorkItemClaimAuthority().route('hive-1', { local: async () => 'OK' } as never);
    expect(r).toBe('OK');
  });

  it('route surfaces a fail-open warning but still returns the value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedRoute.mockResolvedValue({ via: 'local-fail-open', value: 'V', warning: 'no transport' } as never);
    const r = await new SwarmWorkItemClaimAuthority().route('hive-1', { local: async () => 'V' } as never);
    expect(r).toBe('V');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fail-open for hive hive-1'));
    warn.mockRestore();
  });
});

describe('installSwarmWorkItemClaimAuthority', () => {
  beforeEach(() => vi.clearAllMocks());

  it('installs the swarm authority exactly once (idempotent latch)', () => {
    installSwarmWorkItemClaimAuthority();
    installSwarmWorkItemClaimAuthority();
    expect(mockedSet).toHaveBeenCalledTimes(1);
    expect(mockedSet.mock.calls[0]![0]).toBeInstanceOf(SwarmWorkItemClaimAuthority);
  });
});
