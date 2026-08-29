import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

import { agentOriginToolCallOwnersSince } from './assignments';

describe('agentOriginToolCallOwnersSince (WI-583276)', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it('returns only owners with exact agent-origin rows in the bounded window', async () => {
    sqlMock.mockResolvedValue([{ coord_owner_id: 'su-a' }, { coord_owner_id: 'su-a' }, { coord_owner_id: 'su-b' }]);

    await expect(agentOriginToolCallOwnersSince(['su-a', 'su-b'], 15 * 60_000)).resolves.toEqual(
      new Set(['su-a', 'su-b']),
    );

    expect(sqlMock).toHaveBeenCalledTimes(1);
    const statement = String(sqlMock.mock.calls[0]?.[0]?.join?.('') ?? '');
    expect(statement).toContain("call_origin = 'agent'");
    expect(statement).toContain('invoked_at > now()');
    expect(statement).not.toContain('harness_slug');
  });

  it('returns a measured empty set without querying when the roster has no local owners', async () => {
    await expect(agentOriginToolCallOwnersSince(['fed:remote-a', '', 'fed:remote-a'])).resolves.toEqual(new Set());
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('returns UNKNOWN as null when telemetry read fails', async () => {
    sqlMock.mockRejectedValue(new Error('telemetry unavailable'));
    await expect(agentOriginToolCallOwnersSince(['su-a'])).resolves.toBeNull();
  });
});
