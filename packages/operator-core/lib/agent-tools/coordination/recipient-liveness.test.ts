/**
 * recipient-liveness.test.ts — EI-16693: a federated (cross-machine) missed
 * recipient must never be run through the LOCAL liveness oracle (which has no
 * signal for it and used to fall through to a confidently-wrong `ended`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./recipient-resolve', () => ({
  isSelectorOrWildcard: (id: string) => id === '*' || id === 'human' || id === '' || id.startsWith('@'),
  remoteSessionsByOwnerId: vi.fn(async () => new Map()),
}));
vi.mock('./inbox-wake', () => ({ NON_WAKEABLE: new Set(['*', 'human']) }));

const resolveSessionStatesM = vi.fn();
vi.mock('./liveness-oracle', () => ({ resolveSessionStates: resolveSessionStatesM }));

import { remoteSessionsByOwnerId } from './recipient-resolve';
import { describeMissedRecipients } from './recipient-liveness';

const remoteM = vi.mocked(remoteSessionsByOwnerId);

describe('describeMissedRecipients — federated recipients never hit the local oracle', () => {
  beforeEach(() => {
    remoteM.mockReset();
    resolveSessionStatesM.mockReset();
  });

  it('a federated (remote-homed) recipient short-circuits to unknown, never asking the local oracle for it', async () => {
    remoteM.mockResolvedValueOnce(new Map([['su-fbdc1e09-remote', Date.now()]]));
    resolveSessionStatesM.mockResolvedValueOnce(new Map());

    const out = await describeMissedRecipients(['su-fbdc1e09-remote'], { workspaceId: 'ws1' });

    expect(out).toEqual([{ ownerId: 'su-fbdc1e09-remote', sessionState: 'unknown', wakeable: false }]);
    // The local oracle must never even be asked about a remote-homed id.
    expect(resolveSessionStatesM).not.toHaveBeenCalled();
  });

  it('a local recipient still derives its verdict via the shared oracle', async () => {
    remoteM.mockResolvedValueOnce(new Map());
    resolveSessionStatesM.mockResolvedValueOnce(
      new Map([['su-local-1', { ownerId: 'su-local-1', sessionState: 'ended', wakeable: false }]]),
    );

    const out = await describeMissedRecipients(['su-local-1'], { workspaceId: 'ws1' });

    expect(out).toEqual([{ ownerId: 'su-local-1', sessionState: 'ended', wakeable: false }]);
    expect(resolveSessionStatesM).toHaveBeenCalledWith(
      [{ ownerId: 'su-local-1' }],
      { hydratePerId: true, psuHostPositiveAuthority: true },
    );
  });

  it('a mixed batch classifies each id by its own remote/local membership', async () => {
    remoteM.mockResolvedValueOnce(new Map([['su-remote-1', Date.now()]]));
    resolveSessionStatesM.mockResolvedValueOnce(
      new Map([['su-local-1', { ownerId: 'su-local-1', sessionState: 'parked', wakeable: true }]]),
    );

    const out = await describeMissedRecipients(['su-remote-1', 'su-local-1'], { workspaceId: 'ws1' });

    expect(out).toEqual(
      expect.arrayContaining([
        { ownerId: 'su-remote-1', sessionState: 'unknown', wakeable: false },
        { ownerId: 'su-local-1', sessionState: 'parked', wakeable: true },
      ]),
    );
    expect(out).toHaveLength(2);
  });

  it('a remote-detection hiccup degrades to treating every id as local (fail-soft, not a hard failure)', async () => {
    remoteM.mockRejectedValueOnce(new Error('db hiccup'));
    resolveSessionStatesM.mockResolvedValueOnce(new Map());

    const out = await describeMissedRecipients(['su-local-1'], { workspaceId: 'ws1' });

    expect(out).toEqual([{ ownerId: 'su-local-1', sessionState: 'unknown', wakeable: false }]);
    expect(resolveSessionStatesM).toHaveBeenCalled();
  });

  it('omitted workspaceId still works (remoteSessionsByOwnerId itself no-ops without one)', async () => {
    remoteM.mockResolvedValueOnce(new Map());
    resolveSessionStatesM.mockResolvedValueOnce(
      new Map([['su-local-1', { ownerId: 'su-local-1', sessionState: 'live', wakeable: true }]]),
    );

    const out = await describeMissedRecipients(['su-local-1']);

    expect(out).toEqual([{ ownerId: 'su-local-1', sessionState: 'live', wakeable: true }]);
  });
});
