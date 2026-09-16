/**
 * EI-23259368987233359 — a workspace-wide `loop:standdown-all` must freeze the
 * fleet CONTROLLER, not just the members' engine loops.
 *
 * The incident: an owner-directed workspace stand-down stopped and verified
 * every visible session and loop at zero, after which the headcount governor
 * repopulated five members, four loops and four claims — because pausing every
 * `loop-su-%` row says nothing to the governor, and each member it opens arms a
 * fresh loop of its own.
 *
 * These cases pin the guard predicate itself. The two most load-bearing are
 * `fails CLOSED` (a scan error must block top-up, the exact inverse of the
 * fail-OPEN sibling `listLoopStanddownOwners`) and the fleet-scoped case (a
 * one-fleet stand-down must NOT freeze every controller in the workspace).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  DEFAULT_RELEASE_PAUSE_TTL_MS,
  isWorkspaceWideLoopStanddownActive,
} from './release-pause-ttl';

const NOW = 1_700_000_000_000;

/** A pause blob shaped exactly as `loop:standdown-all` stamps it. */
function standdownPause(opts: { fleetSlug?: string; pausedAtMs?: number; expiresAtMs?: number }) {
  const pausedAtMs = opts.pausedAtMs ?? NOW - 60_000;
  return {
    reason: 'coordinated stand-down',
    pausedBy: 'su-test',
    pausedAtMs,
    standdownAll: true,
    expiresAtMs: opts.expiresAtMs ?? pausedAtMs + DEFAULT_RELEASE_PAUSE_TTL_MS,
    ...(opts.fleetSlug ? { fleetSlug: opts.fleetSlug } : {}),
  };
}

/** Minimal tagged-template stand-in for the postgres client. */
function fakeSql(rows: Array<{ pause: unknown }>): Sql {
  return (() => Promise.resolve(rows)) as unknown as Sql;
}

function throwingSql(message: string): Sql {
  return (() => Promise.reject(new Error(message))) as unknown as Sql;
}

describe('isWorkspaceWideLoopStanddownActive', () => {
  it('reports a live workspace-wide stand-down as active', async () => {
    const sql = fakeSql([{ pause: standdownPause({}) }]);
    await expect(isWorkspaceWideLoopStanddownActive(sql, { nowMs: NOW })).resolves.toBe(true);
  });

  it('does NOT treat a fleet-scoped stand-down as a workspace-wide freeze', async () => {
    // A stand-down of one fleet's members is a statement about that fleet, not
    // an instruction to freeze every controller in the workspace.
    const sql = fakeSql([{ pause: standdownPause({ fleetSlug: 'nonp2p-bug-drain-luna-max-50' }) }]);
    await expect(isWorkspaceWideLoopStanddownActive(sql, { nowMs: NOW })).resolves.toBe(false);
  });

  it('releases the hold once the stand-down TTL has lapsed', async () => {
    // Same expiry notion as the loops themselves, so the controller un-freezes
    // at exactly the moment the loops auto-resume.
    const pausedAtMs = NOW - DEFAULT_RELEASE_PAUSE_TTL_MS - 60_000;
    const sql = fakeSql([{ pause: standdownPause({ pausedAtMs }) }]);
    await expect(isWorkspaceWideLoopStanddownActive(sql, { nowMs: NOW })).resolves.toBe(false);
  });

  it('is inactive when no stand-down rows exist', async () => {
    await expect(isWorkspaceWideLoopStanddownActive(fakeSql([]), { nowMs: NOW })).resolves.toBe(false);
  });

  it('finds a live workspace-wide hold alongside expired and fleet-scoped rows', async () => {
    const sql = fakeSql([
      { pause: standdownPause({ fleetSlug: 'some-fleet' }) },
      { pause: standdownPause({ pausedAtMs: NOW - DEFAULT_RELEASE_PAUSE_TTL_MS - 60_000 }) },
      { pause: standdownPause({}) },
    ]);
    await expect(isWorkspaceWideLoopStanddownActive(sql, { nowMs: NOW })).resolves.toBe(true);
  });

  it('FAILS CLOSED on a scan error — the inverse of the fail-open owner-set read', async () => {
    // The whole point of the guard: a read failure must never be reported as
    // "nothing is paused", because this predicate AUTHORIZES spawning. Failing
    // open here silently re-creates EI-23259368987233359.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = throwingSql('connection closed');
      await expect(isWorkspaceWideLoopStanddownActive(sql, { nowMs: NOW })).resolves.toBe(true);
      // The hold must also be LOUD: a persistently unreadable routines table
      // would otherwise pin the governor down while looking like a quiet
      // workspace.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('FAILING CLOSED');
    } finally {
      warn.mockRestore();
    }
  });
});
