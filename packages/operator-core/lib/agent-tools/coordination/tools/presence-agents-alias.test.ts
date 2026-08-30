/**
 * coord:presence `agents` alias (EI-21845811145701209).
 *
 * The roster array lives at the top-level key `active` (see the EI-13298 note
 * in presence.ts) — but readers repeatedly guess `agents` first anyway, and a
 * miss on a guessed key falls through a `|| []` fallback into a silent, valid-
 * looking "zero agents present" instead of a loud error. `agents` is now a
 * real alias of `active` (same reference), so the guess is simply right.
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
import { shapeCoordPresence } from './presence-shape';

const ROWS = [
  { ownerId: 'su-1', sessionState: 'live', wakeable: true },
  { ownerId: 'su-2', sessionState: 'parked', wakeable: false },
];

describe('coord:presence `agents` alias (EI-21845811145701209)', () => {
  beforeEach(() => {
    mocks.resolvePresenceScope.mockReset().mockResolvedValue({
      scope: 'workspace',
      wsId: 'test-workspace',
      potId: null,
    });
    mocks.assemblePresenceSnapshot.mockReset().mockResolvedValue({
      as_of: '2026-08-30T15:00:00.000Z',
      scope: 'workspace',
      etag: 'etag-1',
      summary: { active: ROWS.length, wakeable: 1, byState: { live: 1, parked: 1, ended: 0, recorded: 0 } },
      active: ROWS,
    });
  });

  it('carries `agents` as the SAME array reference as `active` on the raw (full-tier) handler output', async () => {
    const result = (await presenceTool.handler({} as never, {
      workspaceId: 'test-workspace',
      harnessSlug: 'papercusp',
      isSuperuser: true,
    } as never)) as { data: { active: unknown[]; agents: unknown[] } };

    expect(result.data.agents).toBe(result.data.active);
    expect(result.data.agents).toEqual(ROWS);
  });

  it('keeps the alias in sync at the trimmed tier — tier-projected, not the raw full array', () => {
    const raw = {
      as_of: '2026-08-30T15:00:00.000Z',
      scope: 'workspace',
      summary: { active: ROWS.length, wakeable: 1, byState: { live: 1, parked: 1, ended: 0, recorded: 0 } },
      active: ROWS,
      // Simulate the handler's raw `agents` alias (same reference as `active`)
      // arriving at the shaper BEFORE tiering.
      agents: ROWS,
      etag: 'etag-1',
    };

    const out = shapeCoordPresence(raw, 'trimmed') as { active: unknown[]; agents: unknown[] };
    expect(out.agents).toEqual(out.active);
    // Never the raw untrimmed reference re-leaked under the alias key.
    expect(out.agents).not.toBe(ROWS);
  });
});
