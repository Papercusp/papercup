import { describe, expect, it } from 'vitest';
import { resolveEffectiveBootedHandles } from './in-process-status';
import type { BootedHandleSummary } from './boot-all';
import type { RemoteBootedHandlesSnapshot } from './cluster-booted-handles-sync';

/**
 * EI-8816 / WI-3567: unit coverage for the pure decision function behind the
 * substrate-status blind-spot fix. `getInProcessSubstrateStatus` (the impure
 * wrapper wired into dev:dogfood_substrate_status /
 * /api/admin/dogfood-substrate-health) is exercised indirectly by
 * dogfood_substrate_status.test.ts, but the actual owner-vs-worker /
 * fresh-vs-stale decision logic lives entirely in this exported pure
 * function — this file is its dedicated, mock-free unit test.
 */

const H1: BootedHandleSummary = { workspaceId: 'ws1', harnessSlug: 'papercusp' };
const H2: BootedHandleSummary = { workspaceId: 'ws1', harnessSlug: 'other-harness' };

describe('resolveEffectiveBootedHandles (EI-8816)', () => {
  it('owner process (primary / single-process): trusts local directly, reachedSubstrateOwner true', () => {
    const result = resolveEffectiveBootedHandles([H1, H2], {
      isSubstrateOwnerProcess: true,
    });
    expect(result).toEqual({ booted: [H1, H2], reachedSubstrateOwner: true });
  });

  it('owner process with a legitimately empty boot set: still reachedSubstrateOwner true (real idle state, not a blind spot)', () => {
    const result = resolveEffectiveBootedHandles([], {
      isSubstrateOwnerProcess: true,
    });
    expect(result).toEqual({ booted: [], reachedSubstrateOwner: true });
  });

  it('owner process ignores a resolveRemote callback entirely (never consulted for the owner)', () => {
    const result = resolveEffectiveBootedHandles([H1], {
      isSubstrateOwnerProcess: true,
      resolveRemote: () => {
        throw new Error('must not be called when this process owns the substrate');
      },
    });
    expect(result).toEqual({ booted: [H1], reachedSubstrateOwner: true });
  });

  it('worker with a FRESH cached broadcast: trusts the remote snapshot, reachedSubstrateOwner true', () => {
    const now = 1_000_000;
    const remote: RemoteBootedHandlesSnapshot = { handles: [H1], receivedAt: now - 1_000 };
    const result = resolveEffectiveBootedHandles([], {
      isSubstrateOwnerProcess: false,
      resolveRemote: () => remote,
      now,
    });
    expect(result).toEqual({ booted: [H1], reachedSubstrateOwner: true });
  });

  it('worker with a broadcast EXACTLY at the max-age boundary: still fresh (inclusive <=)', () => {
    const now = 1_000_000;
    const maxAgeMs = 15_000;
    const remote: RemoteBootedHandlesSnapshot = { handles: [H1], receivedAt: now - maxAgeMs };
    const result = resolveEffectiveBootedHandles([], {
      isSubstrateOwnerProcess: false,
      resolveRemote: () => remote,
      now,
      maxAgeMs,
    });
    expect(result).toEqual({ booted: [H1], reachedSubstrateOwner: true });
  });

  it('worker with a STALE cached broadcast (older than maxAgeMs): blind-spot marker, not a silent empty', () => {
    const now = 1_000_000;
    const maxAgeMs = 15_000;
    const remote: RemoteBootedHandlesSnapshot = { handles: [H1], receivedAt: now - maxAgeMs - 1 };
    const result = resolveEffectiveBootedHandles([], {
      isSubstrateOwnerProcess: false,
      resolveRemote: () => remote,
      now,
      maxAgeMs,
    });
    expect(result).toEqual({ booted: [], reachedSubstrateOwner: false });
  });

  it('worker with NO cached broadcast yet (resolveRemote returns null): blind-spot marker', () => {
    const result = resolveEffectiveBootedHandles([], {
      isSubstrateOwnerProcess: false,
      resolveRemote: () => null,
    });
    expect(result).toEqual({ booted: [], reachedSubstrateOwner: false });
  });

  it('worker with no resolveRemote wired at all (defaults to null, never throws): blind-spot marker', () => {
    const result = resolveEffectiveBootedHandles([], {
      isSubstrateOwnerProcess: false,
    });
    expect(result).toEqual({ booted: [], reachedSubstrateOwner: false });
  });

  it('worker ignores its own (always-empty) local handles even if somehow populated — trusts remote/blind-spot logic only', () => {
    const now = 1_000_000;
    const remote: RemoteBootedHandlesSnapshot = { handles: [H2], receivedAt: now };
    const result = resolveEffectiveBootedHandles([H1], {
      isSubstrateOwnerProcess: false,
      resolveRemote: () => remote,
      now,
    });
    expect(result).toEqual({ booted: [H2], reachedSubstrateOwner: true });
  });

  it('defaults `now` to Date.now() when omitted (no crash, uses a fresh broadcast as fresh)', () => {
    const remote: RemoteBootedHandlesSnapshot = { handles: [H1], receivedAt: Date.now() };
    const result = resolveEffectiveBootedHandles([], {
      isSubstrateOwnerProcess: false,
      resolveRemote: () => remote,
    });
    expect(result).toEqual({ booted: [H1], reachedSubstrateOwner: true });
  });
});
