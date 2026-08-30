/**
 * coord:presence `ownerIds` compatibility coverage — the plural counterpart of
 * presence-owner-alias.test.ts.
 *
 * `owner`/`ownerId` already accept the roster row's singular field-name spelling
 * as a compatibility alias. Callers naturally guess the same pattern for the
 * bounded plural lookup (`owners`) and reach for `ownerIds` — the exact spelling
 * used internally throughout this package (see `ownerIds` as a function
 * parameter name in liveness-decoration.ts, presence-reaper.ts,
 * context-pressure.ts, etc.). EI-21631841527230352: a caller was rejected with
 * `invalid_args` for passing `ownerIds`, even though the sibling singular alias
 * (`ownerId` → `owner`) is accepted. This file proves `ownerIds` is now
 * normalized to the canonical `owners` selector the same way.
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

describe('coord:presence ownerIds compatibility alias', () => {
  beforeEach(() => {
    mocks.resolvePresenceScope.mockReset().mockResolvedValue({
      scope: 'workspace',
      wsId: 'test-workspace',
      potId: null,
    });
    mocks.assemblePresenceSnapshot.mockReset().mockResolvedValue({
      as_of: '2026-08-30T17:00:00.000Z',
      scope: 'workspace',
      etag: 'etag-1',
      summary: { active: 0, wakeable: 0, byState: {} },
      active: [],
    });
  });

  it('normalizes ownerIds to the canonical owners selector before scope and snapshot reads', async () => {
    await presenceTool.handler(
      { ownerIds: ['su-a', 'su-b'] } as never,
      { workspaceId: 'test-workspace', harnessSlug: 'papercusp', isSuperuser: true } as never,
    );

    expect(mocks.resolvePresenceScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetedOwner: true }),
    );
    expect(mocks.assemblePresenceSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ owners: ['su-a', 'su-b'] }),
    );
    expect(mocks.assemblePresenceSnapshot.mock.calls[0]?.[1]).not.toHaveProperty('ownerIds');
  });

  it('rejects ownerIds combined with owners (both plural spellings at once)', async () => {
    await expect(
      presenceTool.handler(
        { owners: ['su-a'], ownerIds: ['su-b'] } as never,
        { workspaceId: 'test-workspace', harnessSlug: 'papercusp', isSuperuser: true } as never,
      ),
    ).rejects.toThrow();
  });

  it('rejects ownerIds combined with owner (singular + plural-alias mix)', async () => {
    await expect(
      presenceTool.handler(
        { owner: 'su-a', ownerIds: ['su-b'] } as never,
        { workspaceId: 'test-workspace', harnessSlug: 'papercusp', isSuperuser: true } as never,
      ),
    ).rejects.toThrow();
  });
});
