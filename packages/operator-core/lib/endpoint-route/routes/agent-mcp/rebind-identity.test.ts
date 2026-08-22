/**
 * Regression coverage for the SessionStart identity-rebind route.
 *
 * The MCP coord:rebind-identity wrapper already supplied the SU-lock adapter,
 * but the loopback route used by the SessionStart recovery hook did not. A
 * resumed session could therefore move its harness_shared state while leaving
 * file locks under the predecessor SID until TTL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rebindIdentityMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, totalMoved: 0, surfaces: [] })));
const rebindLockOwnerMock = vi.hoisted(() => vi.fn(async () => ({ fileLocksMoved: 0, waitersMoved: 0 })));

vi.mock('../../../agent-tools/coordination/rebind-identity', () => ({ rebindIdentity: rebindIdentityMock }));
vi.mock('../../../agent-tools/locks/su-lock-store', () => ({ rebindLockOwner: rebindLockOwnerMock }));

import routes from './rebind-identity';

const route = routes[0] as unknown as { handler: (req: Request) => Promise<Response> };

function post(body: unknown): Promise<Response> {
  return route.handler(
    new Request('http://localhost:3070/api/agent-mcp/rebind-identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/agent-mcp/rebind-identity', () => {
  it('passes the SU-lock owner rebind into the recovery path', async () => {
    const response = await post({ from: 'su-old', to: 'su-new' });

    expect(response.status).toBe(200);
    expect(rebindIdentityMock).toHaveBeenCalledWith('su-old', 'su-new', {
      force: false,
      rebindLockOwner: rebindLockOwnerMock,
    });
  });

  it('preserves an explicit force flag while wiring the lock adapter', async () => {
    await post({ from: 'su-old', to: 'su-new', force: true });

    expect(rebindIdentityMock).toHaveBeenCalledWith('su-old', 'su-new', {
      force: true,
      rebindLockOwner: rebindLockOwnerMock,
    });
  });
});
