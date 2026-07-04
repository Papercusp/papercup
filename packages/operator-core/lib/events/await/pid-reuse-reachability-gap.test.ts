/**
 * WI-2339 (defect #2) — CHARACTERIZATION / regression tests locking in the death-detection
 * gap found in the cold-loop death/respawn watchdog investigation, BEFORE any fix lands.
 *
 * Root cause (WI-2339 post 50246, su-4072faf3, 2026-07-04): the WI-1399 dead-owner terminal
 * guard (`loop-unreachable-guard.ts`) is gated on `probeWakeReachability(...).reachable`,
 * which in turn trusts `findLiveHost` (psu-pty-discovery.ts) as an UNCONDITIONAL
 * `reachable:true` the moment it reports a host (`wake-reachability.ts` gate "Channel 1b").
 * Neither `findLiveHost` nor the reachability derivation verifies PROCESS IDENTITY — only
 * "does a discovery file exist, does its recorded pid respond to `process.kill(pid,0)`, and
 * does its socket path exist". A dead host's discovery file is unlinked only by that host's
 * OWN graceful `cleanup()` (psu-pty-host.mjs, wired off the child's exit event); an abrupt
 * death (SIGKILL / OOM / terminal closed) never runs it, and garbage collection (`pruneDead`)
 * is opportunistic-only (runs at the next NEW host's boot, not a standing periodic janitor).
 * So on a box with no other psu launches for hours, a dead host's stale discovery file
 * persists — and once the OS eventually recycles that exact pid to ANY unrelated process,
 * `findLiveHost` reports a false-positive live host FOREVER, which makes
 * `probeWakeReachability` report `reachable:true` FOREVER, which means
 * `evaluateUnreachableTerminalGuard`'s very first line (`if (input.reachable) return
 * {breach:false}`) can NEVER breach for that owner — the WI-1399 guard is permanently
 * defeated by a class of bug it was specifically built to catch.
 *
 * STATUS (WI-2339 fix B landed, 2026-07-04): the findLiveHost leg is FIXED — the first
 * describe below now asserts the recycled-pid false positive is REJECTED (process-identity
 * gate: pidIsPsuHost cross-checks the pid's /proc cmdline for the psu-launcher/psu-pty-host
 * marker). The remaining two describes characterize the DOWNSTREAM trust chain
 * (deriveWakeReachability trusts its hasPsuHost input; the WI-1399 guard no-ops on any
 * reachable:true) — each still holds IN ISOLATION and is unchanged by fix B; the point is
 * that fix B stops a recycled pid from ever feeding that chain a false hasPsuHost in the
 * first place. They stay as guards on the chain's contract, so a future regression that
 * re-introduces a fooled host is still caught downstream too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { findLiveHost, sanitizeKey } from './psu-pty-discovery';
import { deriveWakeReachability, probeWakeReachability, type WakeReachabilityInput } from './wake-reachability';
import {
  checkUnreachableTerminalGuard,
  DEFAULT_TERMINAL_UNREACHABLE_MS,
  DEFAULT_MIN_STUCK_FIRES,
} from '../../harness/routines/loop-unreachable-guard';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pid-reuse-gap-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function startSocket(dir: string, ownerId: string): string {
  const sock = join(dir, `${sanitizeKey(ownerId)}.sock`);
  const server = net.createServer();
  server.listen(sock);
  cleanups.push(() => server.close());
  return sock;
}

describe('findLiveHost — WI-2339 defect #2 FIXED: process-identity gate rejects a recycled-pid false positive', () => {
  it('a discovery file whose recorded pid is alive but is a wholly unrelated process is now REJECTED (no longer reported LIVE)', () => {
    // Stand-in for PID reuse: `process.pid` (this test process) is genuinely alive, but the
    // discovery file's identity fields are exactly what a long-dead, unrelated process on a
    // RECYCLED pid would carry. findLiveHost now cross-checks process identity (pidIsPsuHost:
    // the pid's /proc cmdline must carry the psu-launcher/psu-pty-host marker), so this is
    // rejected instead of masquerading as the live host forever.
    const dir = tmpDir();
    const sock = startSocket(dir, 'su-reused-pid');
    writeFileSync(
      join(dir, `${sanitizeKey('su-reused-pid')}.json`),
      JSON.stringify({
        ownerId: 'su-reused-pid',
        pid: process.pid, // alive, but stands in for "OS recycled this exact pid to an unrelated process"
        ptyPid: 999999999,
        command: 'totally-unrelated-process-not-psu-pty-host',
        sock,
        startedAt: 1,
      }),
    );
    // Deterministic (cross-platform): identity fails ⇒ rejected.
    expect(findLiveHost('su-reused-pid', dir, { verifyIdentity: () => false })).toBeNull();
    // And the REAL shipped default (pidIsPsuHost) likewise rejects the vitest process.pid,
    // whose cmdline carries no psu-launcher/psu-pty-host marker — Linux/ship-target only
    // (off-Linux, pidIsPsuHost fail-opens because /proc is absent, unchanged pre-fix behavior).
    if (existsSync('/proc')) expect(findLiveHost('su-reused-pid', dir)).toBeNull();
  });
});

describe('deriveWakeReachability / probeWakeReachability — WI-2339 gap: a false-positive psu-host trumps every death signal', () => {
  const BASE: WakeReachabilityInput = {
    wakeable: true,
    ended: true, // the session row IS marked ended
    pid: null,
    pidAlive: false,
    hasPsuHost: false,
    hasManagedPty: false,
    resumable: false,
    presenceFresh: false,
  };

  it('TODAY (the bug): hasPsuHost:true (the pid-reuse false positive) reports reachable:true via psu-socket even though the session has ENDED', () => {
    const v = deriveWakeReachability({ ...BASE, hasPsuHost: true });
    expect(v).toMatchObject({ reachable: true, channel: 'psu-socket', durableWhileAlive: true });
    // No warning at all — the caller has no signal that anything is amiss.
    expect(v.warning).toBeUndefined();
  });

  it('TODAY (the bug): probeWakeReachability wired to a fooled findPsuHost reports reachable regardless of ended/dead session state', async () => {
    const v = await probeWakeReachability('su-dead', {
      captureHandle: async () => ({ handle: null, note: 'no handle' }),
      getSession: async () => ({ endedAt: '2026-07-03T22:59:03Z', pid: 2352175 }) as any,
      findPsuHost: () => ({ sock: '/stale/but/reported/live.sock' }) as any, // the false positive
      findPty: () => null,
      presence: async () => null,
      listAwaits: async () => [{ id: 1 }] as any, // the standing inbox-wake await (defect #1)
      alive: () => false, // pidAlive is FALSE — irrelevant, hasPsuHost short-circuits first
    });
    expect(v).toMatchObject({ reachable: true, channel: 'psu-socket' });
  });
});

describe('checkUnreachableTerminalGuard — WI-2339 gap: the WI-1399 dead-owner guard is permanently defeated once the probe is fooled', () => {
  it('TODAY (the bug): a probe reporting reachable:true (from the pid-reuse false positive) NEVER breaches, no matter how long parked or how many consecutive stuck fires', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => ({
      reachable: true,
      channel: 'psu-socket' as const,
      durableWhileAlive: true,
      summary: 'live psu-host control socket — wakes inject in place as a fresh turn',
    }));
    const res = await checkUnreachableTerminalGuard(
      {
        sql: {} as never,
        routineId: 'rt-dead-owner',
        targetOwnerId: 'su-dead',
        // Wildly past every threshold — a real dead loop after days of silent halt.
        parkedForMs: DEFAULT_TERMINAL_UNREACHABLE_MS * 100,
        intervalMs: 60_000,
        stuckFireCount: DEFAULT_MIN_STUCK_FIRES * 100,
      },
      { autoPause, probeReachability },
    );
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
    // This is the WI-2339 finding in one assertion: the guard purpose-built to catch a
    // permanently-dead owner (WI-1399) cannot fire once `probeWakeReachability` is fooled —
    // there is no secondary, independent liveness signal it falls back to.
  });
});
