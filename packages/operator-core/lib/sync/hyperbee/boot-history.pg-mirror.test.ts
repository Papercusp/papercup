/**
 * EI-18655247267756605 — boot-history PG mirror (the durable half of the
 * WI-5781 fix).
 *
 * Both boot-history rings are process-local, so the admission-decision trail
 * dies with the process — restart-class federation bugs (cold-restart
 * re-peer, join-path) are structurally undiagnosable post-hoc. WI-5781 fixed
 * this for the CHEAP half (stdout mirror, pinned by
 * boot-history.stdout-mirror.test.ts); these tests pin the DURABLE half: the
 * same sparse kind set is also handed to the PG-write seam, so it can survive
 * into harness_shared.boot_history_events across a restart, not just into a
 * banked serve log.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetBootHistoryForTests,
  _setPgWriteForTests,
  listBootHistory,
  recordBootEvent,
  type BootHistoryEntry,
} from './boot-history';

function capturePgWrites(): BootHistoryEntry[] {
  const entries: BootHistoryEntry[] = [];
  _setPgWriteForTests((entry) => entries.push(entry));
  return entries;
}

describe('boot-history PG mirror (EI-18655247267756605)', () => {
  beforeEach(() => {
    _resetBootHistoryForTests();
  });

  it('hands admission DECISIONS — the WI-5781 blind spot — to the PG-write seam, including the buffered miss', () => {
    const entries = capturePgWrites();

    recordBootEvent('ws1', 'hello-world', 'announce_admitted', 'log=5fe26c2e0135');
    recordBootEvent('ws1', 'hello-world', 'announce_pending', 'log=004b6867bece membership miss');

    expect(entries.map((e) => e.kind)).toEqual(['announce_admitted', 'announce_pending']);
    expect(entries.every((e) => e.workspaceId === 'ws1' && e.harnessSlug === 'hello-world')).toBe(
      true,
    );
    expect(entries[1]!.message).toBe('log=004b6867bece membership miss');
  });

  it('hands the join-lifecycle and peer-admissibility forensic kinds to the PG-write seam — the SAME set as the stdout mirror', () => {
    const entries = capturePgWrites();

    for (const kind of [
      'announce_rejected',
      'announce_clock_skew',
      'announce_error',
      'join_started',
      'join_succeeded',
      'swarm_join_failed',
      'peer_revoked',
      'peer_unrevoked',
      'boot_fail',
    ] as const) {
      recordBootEvent('ws1', 'h', kind);
    }

    expect(entries).toHaveLength(9);
  });

  it('persists the epoch boot device identity so restart cannot erase split-identity evidence', () => {
    const entries = capturePgWrites();

    recordBootEvent(
      'ws1',
      'h',
      'epoch_boot_device',
      'pubkey=device-a keychainId=github:1 tiers=secretTool:false,securityCli:true,file:primary',
    );

    expect(entries).toEqual([
      expect.objectContaining({
        workspaceId: 'ws1',
        harnessSlug: 'h',
        kind: 'epoch_boot_device',
      }),
    ]);
  });

  it('does NOT hand the high-frequency epoch trace or peer_connected to the PG-write seam', () => {
    const entries = capturePgWrites();

    // Same rationale as the stdout mirror: mirroring either to PG would turn a
    // sparse forensic signal into a write-amplifying hot path.
    recordBootEvent('ws1', 'h', 'peer_connected', 'peer=abc');
    recordBootEvent('ws1', 'h', 'epoch_gate_seen');
    recordBootEvent('ws1', 'h', 'epoch_defer');
    recordBootEvent('ws1', 'h', 'epoch_decrypt_fail');
    recordBootEvent('ws1', 'h', 'epoch_applied');

    expect(entries).toEqual([]);
  });

  it('still records mirrored kinds to the in-memory ring (the PG mirror ADDS a sink, never replaces one)', () => {
    capturePgWrites();
    recordBootEvent('ws1', 'hello-world', 'announce_pending', 'log=004b6867bece');

    const hist = listBootHistory({ workspaceId: 'ws1' });
    expect(hist.some((e) => e.kind === 'announce_pending')).toBe(true);
  });

  it('never lets a throwing PG-write impl break the caller', () => {
    // Every call site is a diagnostic on a live boot/merge/announce path, so a
    // PG-write failure must not propagate into federation.
    _setPgWriteForTests(() => {
      throw new Error('connection refused');
    });

    expect(() =>
      recordBootEvent('ws1', 'h', 'announce_admitted', 'log=deadbeef'),
    ).not.toThrow();
    // and the ring write still happened
    expect(
      listBootHistory({ workspaceId: 'ws1' }).some((e) => e.kind === 'announce_admitted'),
    ).toBe(true);
  });

  it('resets to the real (lazy-imported) default impl after _resetBootHistoryForTests, so a leaked test seam cannot silently break the next test file', () => {
    _setPgWriteForTests(() => {
      throw new Error('should never run after reset');
    });
    _resetBootHistoryForTests();
    // The default impl only ever kicks off a fire-and-forget dynamic import +
    // promise chain — it must not throw synchronously even against a table
    // that (in this unit-test process) never actually exists.
    expect(() => recordBootEvent('ws1', 'h', 'announce_admitted')).not.toThrow();
  });
});
