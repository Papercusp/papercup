/**
 * Tests for the wake-deaf pty-host guard (EI-20287339148365013).
 *
 * Several of these encode facts that were WRONG in the first draft and were corrected by
 * calibrating against the live host population. They are marked as such, because a guard
 * whose assumptions were falsified once is exactly the guard that needs them pinned.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  classifyComposerWedge,
  sweepWedgedPtyHosts,
  DEFER_KIND,
  DEFAULT_MIN_CONSECUTIVE_DEFERS,
  DEFAULT_MIN_STREAK_SPAN_MS,
  type PtyHostWedgeSweepDeps,
} from './pty-host-wedge-guard';
import type { PtyHostEvent, PsuPtyHost } from '../../events/await/psu-pty-discovery';

const HOST_STARTED = Date.parse('2026-08-12T06:00:00.000Z');
const NOW = Date.parse('2026-08-12T22:00:00.000Z');

/** A run of defers ending at `endIso`, spaced `spacingMs` apart, oldest-first. */
function defers(
  count: number,
  opts: { pendingLength?: number; endMs?: number; spacingMs?: number; forensics?: boolean } = {},
): PtyHostEvent[] {
  const { pendingLength = 11, endMs = NOW - 60_000, spacingMs = 10 * 60_000, forensics = false } = opts;
  const out: PtyHostEvent[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({
      ts: new Date(endMs - i * spacingMs).toISOString(),
      kind: DEFER_KIND,
      reason: 'owner-input-cap',
      pendingLength,
      ...(forensics ? { pendingAgeMs: 120_000, ownerQuietMs: 120_000 } : {}),
    });
  }
  return out;
}

function ev(kind: string, atMs: number, extra: Record<string, unknown> = {}): PtyHostEvent {
  return { ts: new Date(atMs).toISOString(), kind, ...extra };
}

function classify(events: PtyHostEvent[], over: Partial<Parameters<typeof classifyComposerWedge>[0]> = {}) {
  return classifyComposerWedge({ events, startedAtMs: HOST_STARTED, now: NOW, ...over });
}

describe('classifyComposerWedge', () => {
  it('names a host whose wakes are all deferred against one unchanging staged line', () => {
    const v = classify(defers(12));
    expect(v.wedged).toBe(true);
    expect(v.consecutiveDefers).toBe(12);
    expect(v.pendingLength).toBe(11);
    expect(v.reason).toContain('11-char');
  });

  it('reports no wedge when the ledger holds no deferrals at all', () => {
    const v = classify([ev('respawned', NOW - 60_000)]);
    expect(v.wedged).toBe(false);
    expect(v.consecutiveDefers).toBe(0);
  });

  // THE SCOPING TRAP. The per-owner ledger OUTLIVES the host process; counting unscoped
  // charged four hosts with their predecessors' incidents (2026-08-12 retraction).
  it('ignores deferrals from a PREVIOUS host incarnation', () => {
    const previous = defers(30, { endMs: HOST_STARTED - 60_000 });
    const mine = defers(2, { endMs: NOW - 60_000 });
    const v = classify([...previous, ...mine]);
    expect(v.consecutiveDefers).toBe(2);
    expect(v.wedged).toBe(false);
  });

  it('counts a run that is exactly at the floor, and not one below it', () => {
    expect(classify(defers(DEFAULT_MIN_CONSECUTIVE_DEFERS)).wedged).toBe(true);
    expect(classify(defers(DEFAULT_MIN_CONSECUTIVE_DEFERS - 1)).wedged).toBe(false);
  });

  // THE FALSE-POSITIVE CONTROL. A person's line changes length as they type, so each defer
  // starts a fresh run of one — a human can never accumulate a streak however long they
  // leave a message unsent.
  it('never accumulates a streak for a human typing (the staged length moves)', () => {
    const typing: PtyHostEvent[] = [];
    for (let i = 0; i < 30; i++) {
      typing.push(...defers(1, { pendingLength: 10 + i, endMs: NOW - (30 - i) * 60_000 }));
    }
    const v = classify(typing);
    expect(v.wedged).toBe(false);
    expect(v.consecutiveDefers).toBe(1);
  });

  it('treats a different staged length as a run BOUNDARY, not a poisoned run', () => {
    // A long phantom episode, then one defer against a different line (su-efa8b152's shape).
    const v = classify([...defers(20, { pendingLength: 11, endMs: NOW - 120 * 60_000 }), ...defers(1, { pendingLength: 31 })]);
    expect(v.consecutiveDefers).toBe(1);
    expect(v.pendingLength).toBe(31);
    expect(v.wedged).toBe(false);
  });

  // CALIBRATION REGRESSION GUARD. Trusting carry-delivery as proof the composer cleared
  // cut recall from 3 known-wedged hosts to 1: on su-91ef0643 the phantom demonstrably
  // SURVIVES `respawned` + `respawn-carry-delivered`, twice, across four hours.
  it('does NOT treat a respawn or its carry delivery as clearing the staged line', () => {
    const v = classify([
      ...defers(6, { endMs: NOW - 200 * 60_000 }),
      ev('respawned', NOW - 190 * 60_000),
      ev('respawn-carry-delivered', NOW - 189 * 60_000),
      ...defers(6, { endMs: NOW - 60_000 }),
    ]);
    expect(v.wedged).toBe(true);
    expect(v.consecutiveDefers).toBe(12);
  });

  it('DOES end the run at an explicit composer clear', () => {
    const v = classify([
      ...defers(20, { endMs: NOW - 200 * 60_000 }),
      ev('owner-composer-wedge-cleared', NOW - 190 * 60_000),
      ...defers(3, { endMs: NOW - 60_000 }),
    ]);
    expect(v.consecutiveDefers).toBe(3);
    expect(v.wedged).toBe(false);
  });

  it('ends the run when a human is observed typing', () => {
    const v = classify([
      ...defers(20, { endMs: NOW - 200 * 60_000 }),
      ev('owner-input-during-compact-wait', NOW - 190 * 60_000),
      ...defers(2, { endMs: NOW - 60_000 }),
    ]);
    expect(v.wedged).toBe(false);
  });

  it('steps over unrelated lifecycle events without breaking the run', () => {
    const v = classify([
      ...defers(6, { endMs: NOW - 200 * 60_000 }),
      ev('mcp-reconnect-started', NOW - 190 * 60_000),
      ev('stale-fire-dropped', NOW - 185 * 60_000),
      ev('wake-turn-deferred-for-pending-respawn', NOW - 180 * 60_000, { reason: 'pending-respawn' }),
      ...defers(6, { endMs: NOW - 60_000 }),
    ]);
    expect(v.wedged).toBe(true);
    expect(v.consecutiveDefers).toBe(12);
  });

  it('refuses a burst — many deferrals inside a span too short to be a wedge', () => {
    const v = classify(defers(20, { spacingMs: 1_000 }));
    expect(v.wedged).toBe(false);
    expect(v.streakSpanMs).toBeLessThan(DEFAULT_MIN_STREAK_SPAN_MS);
    expect(v.reason).toContain('backpressure');
  });

  it('reports whether the host emitted the forensics fields the in-host breaker keys on', () => {
    expect(classify(defers(12, { forensics: false })).emitsForensics).toBe(false);
    expect(classify(defers(12, { forensics: true })).emitsForensics).toBe(true);
    // The absence is the "cannot self-heal" signature, so it must reach the human-readable line.
    expect(classify(defers(12, { forensics: false })).reason).toContain('too old');
  });

  it('stops at an event with no readable timestamp rather than crediting it to this host', () => {
    const v = classify([...defers(6, { endMs: NOW - 200 * 60_000 }), { kind: DEFER_KIND, pendingLength: 11 }]);
    expect(v.consecutiveDefers).toBe(0);
  });
});

/**
 * THE LAYERING PROPERTY, asserted mechanically rather than documented.
 *
 * This guard is only meaningful if it sits ABOVE the in-host breaker: a host running
 * current code must break its own wedge before this ever names it, so that a firing here
 * is itself evidence the first-line fix could not run. Raising the breaker's default past
 * this floor would silently invert that, and nothing else in either file would fail.
 */
describe('threshold layering against the in-host breaker', () => {
  it('sits strictly above psu-pty-host.mjs shouldBreakComposerWedge maxDefers default', () => {
    const source = readFileSync(
      new URL('../../../../../apps/operator/scripts/psu-pty-host.mjs', import.meta.url),
      'utf8',
    );
    // Anchored to the shouldBreakComposerWedge destructuring specifically, so a stray
    // `maxDefers = <small number>` elsewhere in the file cannot make this pass vacuously.
    // `[\d_]` because the source writes numeric separators (`minQuietMs = 90_000`).
    const m = /minQuietMs\s*=\s*[\d_]+,\s*maxDefers\s*=\s*([\d_]+)/.exec(source);
    expect(m, 'could not find the in-host breaker maxDefers default — did it move?').toBeTruthy();
    const inHostDefault = Number(m![1].replace(/_/g, ''));
    expect(Number.isFinite(inHostDefault)).toBe(true);
    expect(inHostDefault).toBeGreaterThan(0);
    expect(DEFAULT_MIN_CONSECUTIVE_DEFERS).toBeGreaterThan(inHostDefault);
  });
});

function host(over: Partial<PsuPtyHost> = {}): PsuPtyHost {
  return {
    ownerId: 'su-test',
    advSessionId: null,
    pid: 4242,
    ptyPid: 4243,
    sock: '/tmp/x.sock',
    command: 'claude',
    startedAt: HOST_STARTED,
    ...over,
  } as PsuPtyHost;
}

function sweepDeps(over: Partial<PtyHostWedgeSweepDeps> = {}): PtyHostWedgeSweepDeps {
  return {
    listHosts: () => [host()],
    readEvents: () => defers(12),
    readStartedAt: () => HOST_STARTED,
    broadcast: vi.fn(async () => true),
    notify: vi.fn(async () => undefined),
    now: NOW,
    ...over,
  };
}

describe('sweepWedgedPtyHosts', () => {
  it('reports a wedged host and broadcasts once', async () => {
    const deps = sweepDeps();
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.checked).toBe(1);
    expect(res.wedged).toHaveLength(1);
    expect(res.wedged[0].ownerId).toBe('su-test');
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
  });

  it('stays silent when nothing is wedged', async () => {
    const deps = sweepDeps({ readEvents: () => defers(2) });
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.wedged).toHaveLength(0);
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('does not broadcast under dryRun, but still reports', async () => {
    const deps = sweepDeps();
    const res = await sweepWedgedPtyHosts({ dryRun: true }, deps);
    expect(res.wedged).toHaveLength(1);
    expect(res.dryRun).toBe(true);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  // "I could not see" and "there is nothing there" are the two readings this must never
  // conflate — an unreadable ledger is reported, never silently counted as healthy.
  it('reports an unreadable ledger as unreadable rather than as clean', async () => {
    const res = await sweepWedgedPtyHosts({}, sweepDeps({ readEvents: () => [] }));
    expect(res.unreadable).toEqual(['su-test']);
    expect(res.wedged).toHaveLength(0);
  });

  it('classifies a still-emitting wedged host as BUSY so it is never trampled', async () => {
    const res = await sweepWedgedPtyHosts(
      {},
      sweepDeps({ listHosts: () => [host({ lastOutputAt: NOW - 30_000 })] }),
    );
    expect(res.wedged[0].recoverySafety).toBe('busy');
  });

  it('classifies a long-silent wedged host as IDLE', async () => {
    const res = await sweepWedgedPtyHosts(
      {},
      sweepDeps({ listHosts: () => [host({ lastOutputAt: NOW - 60 * 60_000 })] }),
    );
    expect(res.wedged[0].recoverySafety).toBe('idle');
    expect(res.wedged[0].idleMs).toBe(60 * 60_000);
  });

  // Absent evidence must not authorise action: the dangerous error here is destroying
  // in-flight work, so an unknown activity stamp fails toward "do not touch".
  it('classifies a host with no activity stamps as UNKNOWN, not idle', async () => {
    const res = await sweepWedgedPtyHosts({}, sweepDeps());
    expect(res.wedged[0].recoverySafety).toBe('unknown');
    expect(res.wedged[0].idleMs).toBeNull();
  });

  it('orders the report worst-first', async () => {
    const deps = sweepDeps({
      listHosts: () => [host({ ownerId: 'su-small' }), host({ ownerId: 'su-big' })],
      readEvents: (ownerId: string) => defers(ownerId === 'su-big' ? 25 : 10),
    });
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.wedged.map((w) => w.ownerId)).toEqual(['su-big', 'su-small']);
  });

  it('survives a broadcast failure without failing the sweep', async () => {
    const deps = sweepDeps({
      broadcast: vi.fn(async () => {
        throw new Error('coord down');
      }),
    });
    const res = await sweepWedgedPtyHosts({}, deps);
    expect(res.wedged).toHaveLength(1);
  });
});
