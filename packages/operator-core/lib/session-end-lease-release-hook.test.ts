import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runSessionEndLeaseRelease,
  scheduleSessionEndLeaseRelease,
  type SessionEndLeaseReleaseDeps,
  type SessionEndLeaseRow,
} from './session-end-lease-release-hook';

const ENDED: SessionEndLeaseRow = {
  id: 77,
  coordOwnerId: 'su-ended',
  cwd: '/repo',
  endedAt: new Date('2026-08-22T20:01:13Z'),
  ownerHasOpenSession: false,
};

const h = {
  loadRow: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['loadRow']>>(),
  loadProtectedOwners: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['loadProtectedOwners']>>(),
  releaseLocks: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['releaseLocks']>>(),
  releaseWorkItems: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['releaseWorkItems']>>(),
};

function deps(): SessionEndLeaseReleaseDeps {
  return {
    loadRow: h.loadRow,
    loadProtectedOwners: h.loadProtectedOwners,
    releaseLocks: h.releaseLocks,
    releaseWorkItems: h.releaseWorkItems,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  h.loadRow.mockResolvedValue(ENDED);
  h.loadProtectedOwners.mockResolvedValue(new Set());
  h.releaseLocks.mockResolvedValue({
    released: ['a.ts', 'b.ts'],
    heldBefore: 2,
    crossDomainReleased: [],
    resourcesReleased: 1,
  });
  h.releaseWorkItems.mockResolvedValue({ releasedIds: ['EI-1'], claimsCleared: 1 });
});

describe('runSessionEndLeaseRelease', () => {
  it('releases every lease only after the tracked owner is ended and unprotected', async () => {
    const result = await runSessionEndLeaseRelease(77, deps());

    expect(h.releaseLocks).toHaveBeenCalledWith({ ownerId: 'su-ended', primaryCoordinationDomain: '/repo' });
    expect(h.releaseWorkItems).toHaveBeenCalledWith('su-ended');
    expect(result).toMatchObject({
      ok: true,
      ownerId: 'su-ended',
      releasedPaths: ['a.ts', 'b.ts'],
      resourcesReleased: 1,
      releasedWorkItems: ['EI-1'],
      claimsCleared: 1,
    });
  });

  it('protects a carry/resume successor represented by a newer open session row', async () => {
    h.loadRow.mockResolvedValueOnce({ ...ENDED, ownerHasOpenSession: true });
    await expect(runSessionEndLeaseRelease(77, deps())).resolves.toMatchObject({
      ok: false,
      reason: 'owner-resumed',
    });
    expect(h.loadProtectedOwners).not.toHaveBeenCalled();
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.releaseWorkItems).not.toHaveBeenCalled();
  });

  it('protects a live owner even when the old adv row is ended', async () => {
    h.loadProtectedOwners.mockResolvedValueOnce(new Set(['su-ended']));
    await expect(runSessionEndLeaseRelease(77, deps())).resolves.toMatchObject({
      ok: false,
      reason: 'owner-live',
    });
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.releaseWorkItems).not.toHaveBeenCalled();
  });

  it.each([
    ['row-not-found', null],
    ['row-not-ended', { ...ENDED, endedAt: null }],
    ['owner-missing', { ...ENDED, coordOwnerId: null }],
  ] as const)('fails closed on %s', async (reason, row) => {
    h.loadRow.mockResolvedValueOnce(row);
    await expect(runSessionEndLeaseRelease(77, deps())).resolves.toMatchObject({ ok: false, reason });
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.releaseWorkItems).not.toHaveBeenCalled();
  });

  it('isolates the two cleanup stores so one failure cannot skip the other', async () => {
    h.releaseLocks.mockRejectedValueOnce(new Error('locks db down'));
    const result = await runSessionEndLeaseRelease(77, deps());

    expect(h.releaseWorkItems).toHaveBeenCalledWith('su-ended');
    expect(result).toMatchObject({
      ok: false,
      reason: 'partial-failure',
      failedEffects: ['locks'],
      releasedWorkItems: ['EI-1'],
      claimsCleared: 1,
    });
  });
});

describe('scheduleSessionEndLeaseRelease', () => {
  it('does not run cleanup inline with the tracked end writer', async () => {
    vi.useFakeTimers();
    scheduleSessionEndLeaseRelease(77, { delayMs: 25, deps: deps() });
    expect(h.loadRow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24);
    expect(h.loadRow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.releaseLocks).toHaveBeenCalledTimes(1);
    expect(h.releaseWorkItems).toHaveBeenCalledTimes(1);
  });
});

describe('markAdvSessionEnded wiring', () => {
  it('schedules the lease cleanup only after the tracked end update succeeds', () => {
    const source = readFileSync(new URL('./adv-sessions.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function markAdvSessionEnded');
    const end = source.indexOf('/**\n * Re-activate a tracked session row on RESUME', start);
    const body = source.slice(start, end);
    const successfulUpdate = body.slice(body.indexOf('if (r.length) {'));

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(successfulUpdate).toContain("import('./session-end-lease-release-hook')");
    expect(successfulUpdate).toContain('scheduleSessionEndLeaseRelease(id)');
  });
});
