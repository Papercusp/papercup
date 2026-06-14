import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./authority/lock-authority', () => ({ routeToAuthorityForHive: vi.fn() }));
vi.mock('./work-item-replica-authority', () => ({ setWorkItemReplicaAuthority: vi.fn() }));

import {
  SwarmWorkItemReplicaAuthority,
  installSwarmWorkItemReplicaAuthority,
  __resetSwarmWorkItemReplicaAuthorityForTests,
} from './work-item-replica-authority-swarm';
import { routeToAuthorityForHive } from './authority/lock-authority';
import { setWorkItemReplicaAuthority } from './work-item-replica-authority';

const mockedRoute = vi.mocked(routeToAuthorityForHive);
const mockedSet = vi.mocked(setWorkItemReplicaAuthority);

describe('SwarmWorkItemReplicaAuthority', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isSelf reflects whether we are the Hive authority', async () => {
    mockedRoute.mockResolvedValue({ via: 'local-authority', value: true } as never);
    expect(await new SwarmWorkItemReplicaAuthority().isSelf('h')).toBe(true);
    mockedRoute.mockResolvedValue({ via: 'remote', value: true } as never);
    expect(await new SwarmWorkItemReplicaAuthority().isSelf('h')).toBe(false);
  });

  it('route returns the op value and warns on fail-open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedRoute.mockResolvedValue({ via: 'local-fail-open', value: 42, warning: 'unreachable' } as never);
    const r = await new SwarmWorkItemReplicaAuthority().route('h', { local: async () => 42 } as never);
    expect(r).toBe(42);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[work-item-replica] authority fail-open'));
    warn.mockRestore();
  });
});

describe('installSwarmWorkItemReplicaAuthority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSwarmWorkItemReplicaAuthorityForTests();
  });

  it('installs once until reset (the test seam re-arms the latch)', () => {
    installSwarmWorkItemReplicaAuthority();
    installSwarmWorkItemReplicaAuthority();
    expect(mockedSet).toHaveBeenCalledTimes(1);
    expect(mockedSet.mock.calls[0]![0]).toBeInstanceOf(SwarmWorkItemReplicaAuthority);

    __resetSwarmWorkItemReplicaAuthorityForTests();
    installSwarmWorkItemReplicaAuthority();
    expect(mockedSet).toHaveBeenCalledTimes(2);
  });
});
