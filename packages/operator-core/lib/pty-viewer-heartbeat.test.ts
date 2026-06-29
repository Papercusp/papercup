import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the org PG so the best-effort DB helpers are exercised without a live DB.
const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: sqlMock }) }));

import {
  gatherViewerAttachedOwners,
  recordViewerAttached,
  refreshViewerAttached,
  clearViewerAttached,
  VIEWER_ATTACH_TTL_MS,
} from './pty-viewer-heartbeat';

beforeEach(() => {
  sqlMock.mockReset();
});

describe('pty-viewer-heartbeat', () => {
  it('gatherViewerAttachedOwners returns the DISTINCT owner_sids from the query', async () => {
    sqlMock.mockResolvedValueOnce([{ owner_sid: 'su-a' }, { owner_sid: 'su-b' }]);
    const owners = await gatherViewerAttachedOwners();
    expect(owners).toEqual(new Set(['su-a', 'su-b']));
  });

  it('gatherViewerAttachedOwners fails to an EMPTY set (best-effort) on a DB error', async () => {
    sqlMock.mockRejectedValueOnce(new Error('db down'));
    const owners = await gatherViewerAttachedOwners();
    expect(owners).toEqual(new Set());
  });

  it('recordViewerAttached no-ops without an ownerSid (nothing for the reaper to protect by)', async () => {
    await recordViewerAttached('pty-1', null);
    await recordViewerAttached('pty-1', '');
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('recordViewerAttached writes when an ownerSid is present', async () => {
    sqlMock.mockResolvedValueOnce(undefined);
    await recordViewerAttached('pty-1', 'su-a');
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('every write swallows errors — a viewer signal must never throw into the socket', async () => {
    sqlMock.mockRejectedValue(new Error('db down'));
    await expect(recordViewerAttached('pty-1', 'su-a')).resolves.toBeUndefined();
    await expect(refreshViewerAttached('pty-1')).resolves.toBeUndefined();
    await expect(clearViewerAttached('pty-1')).resolves.toBeUndefined();
  });

  it('TTL is 3x the pty-ws 30s keepalive ping (a dropped viewer expires within ~90s)', () => {
    expect(VIEWER_ATTACH_TTL_MS).toBe(90_000);
  });
});
