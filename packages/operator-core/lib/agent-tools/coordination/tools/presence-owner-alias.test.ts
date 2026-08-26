/**
 * coord:presence ownerId compatibility coverage.
 *
 * The roster exposes `ownerId` on each row, so older callers naturally reused
 * that field for the targeted input. The public tool accepts that spelling only
 * at the boundary and must pass the canonical `owner` selector downstream.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolvePresenceScope: vi.fn(),
  assemblePresenceSnapshot: vi.fn(),
}));

vi.mock('../presence-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../presence-snapshot')>()),
  resolvePresenceScope: mocks.resolvePresenceScope,
  assemblePresenceSnapshot: mocks.assemblePresenceSnapshot,
}));

vi.mock('../../locks/identity', () => ({
  readIdentity: vi.fn(() => ({ coordinationDomain: '/tmp/papercusp-test' })),
}));

vi.mock('../self-marker', () => ({
  resolveSelfRef: vi.fn(() => null),
  markSelfRows: vi.fn((rows: unknown[]) => rows),
}));

vi.mock('../presence-cursor-overlay', () => ({
  overlayPresenceCursors: vi.fn(async (rows: unknown[]) => rows),
}));

import presenceTool from './presence';

describe('coord:presence ownerId compatibility alias', () => {
  beforeEach(() => {
    mocks.resolvePresenceScope.mockReset().mockResolvedValue({
      scope: 'workspace',
      wsId: 'test-workspace',
      potId: null,
    });
    mocks.assemblePresenceSnapshot.mockReset().mockResolvedValue({
      as_of: '2026-08-26T15:00:00.000Z',
      scope: 'workspace',
      etag: 'etag-1',
      summary: { active: 0, wakeable: 0, byState: {} },
      active: [],
    });
  });

  it('normalizes ownerId to the canonical owner selector before scope and snapshot reads', async () => {
    await presenceTool.handler(
      { ownerId: 'su-target' } as never,
      { workspaceId: 'test-workspace', harnessSlug: 'papercusp', isSuperuser: true } as never,
    );

    expect(mocks.resolvePresenceScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetedOwner: true }),
    );
    expect(mocks.assemblePresenceSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ owner: 'su-target' }),
    );
    expect(mocks.assemblePresenceSnapshot.mock.calls[0]?.[1]).not.toHaveProperty('ownerId');
  });
});
