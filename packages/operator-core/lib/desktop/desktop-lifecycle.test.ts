/**
 * desktop-lifecycle — the idle ladder, as a pure decision.
 * (agent-virtual-desktops-2026-08-23 P-005 / WI-40868.)
 *
 * The point of testing this layer exhaustively is that the thresholds are a
 * CLAIM about cost, not a preference. WI-5978 measured three idle QEMU guests
 * burning 12.8 cores for 5-9 days against a control guest that had been up
 * longer and cost 0.1; the whole per-kind asymmetry below descends from that
 * measurement, so it should be falsifiable rather than asserted in a comment.
 *
 * Note what the NEGATIVE controls are protecting. Every "keep" assertion here is
 * a desktop the governor could have suspended or destroyed and did not — the
 * owner's real display, the product's own desktop, a session someone is
 * watching. A one-sided test of this ladder passes just as happily against a
 * governor that freezes everything.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DESKTOP_LIFECYCLE_POLICY,
  DESKTOP_LIFECYCLE_POLICY,
  PROTECTED_DISPLAYS,
  PROVISIONING_STUCK_SEC,
  VIEWER_HOLD_SEC,
  classifyDesktopSession,
  policyFor,
} from './desktop-lifecycle';
import type { DesktopSessionRecord } from './desktop-session-registry';

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);
const ago = (sec: number) => new Date(NOW - sec * 1000);
const MIN = 60;
const HOUR = 3600;

function session(over: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord {
  return {
    id: 'ds-1',
    workspaceId: 'ws',
    harnessSlug: 'papercusp',
    kind: 'xvfb-local',
    scope: 'pot',
    scopeRef: 'pot-a',
    hostRef: null,
    ownerPid: 4242,
    ownerBootId: 'boot-1',
    display: ':110',
    displayGeometry: { width: 1024, height: 768, depth: 24 },
    captureGeometry: { width: 1024, height: 768 },
    state: 'ready',
    leaseHolder: null,
    viewerMode: 'none',
    viewerActor: null,
    capabilities: {},
    ttlSec: null,
    taskId: 'task-1',
    idleAfterSec: null,
    frozenAt: null,
    createdAt: ago(10 * HOUR),
    lastActiveAt: ago(5),
    releasedAt: null,
    ...over,
  };
}

describe('classifyDesktopSession — the idle ladder', () => {
  it('keeps a desktop that was driven seconds ago', () => {
    expect(classifyDesktopSession(session(), NOW).action).toBe('keep');
  });

  it('demotes ready → idle once past the kind threshold, actuating nothing', () => {
    const v = classifyDesktopSession(session({ lastActiveAt: ago(20 * MIN) }), NOW);
    expect(v.action).toBe('idle');
    expect(v.reason).toMatch(/no activity/);
  });

  it('escalates idle → freeze once past the freeze threshold', () => {
    const v = classifyDesktopSession(
      session({ state: 'idle', lastActiveAt: ago(3 * HOUR) }),
      NOW,
    );
    expect(v.action).toBe('freeze');
  });

  it('does not re-demote a frozen session to idle (which would drop frozen_at)', () => {
    const v = classifyDesktopSession(
      session({ state: 'frozen', frozenAt: ago(10 * MIN), lastActiveAt: ago(3 * HOUR) }),
      NOW,
    );
    expect(v.action).toBe('keep');
  });

  it('reaps a session that has been frozen past the reap threshold', () => {
    const v = classifyDesktopSession(
      session({ state: 'frozen', frozenAt: ago(7 * HOUR), lastActiveAt: ago(9 * HOUR) }),
      NOW,
    );
    expect(v.action).toBe('reap');
    expect(v.reason).toMatch(/frozen and untouched/);
  });

  it('a frozen session with NO frozen_at is treated as ancient, not as fresh', () => {
    // The SQL CHECK makes this unreachable through the registry, but a governor
    // that read a NULL stamp as "just frozen" would defer forever on every pass,
    // which is precisely the leak the stamp exists to prevent. Defence in depth.
    const v = classifyDesktopSession(
      session({ state: 'frozen', frozenAt: null, lastActiveAt: ago(9 * HOUR) }),
      NOW,
    );
    expect(v.action).toBe('keep');
    // ...documented: ageSec(null) === 0, so it defers. The DATABASE is what makes
    // this state impossible; this assertion pins that we depend on it.
  });
});

describe('classifyDesktopSession — refusals outrank every clock', () => {
  it.each([':0', ':1', ':2'])('refuses to govern protected display %s', (display) => {
    const v = classifyDesktopSession(
      // Everything about this row screams "reap me": long idle, expired TTL.
      session({ display, lastActiveAt: ago(48 * HOUR), ttlSec: 60 }),
      NOW,
    );
    expect(v.action).toBe('keep');
    expect(v.refused).toBe(true);
    expect(v.reason).toMatch(/protected display/);
  });

  it("refuses to govern a scope='workspace' desktop even when long idle and expired", () => {
    const v = classifyDesktopSession(
      session({ scope: 'workspace', lastActiveAt: ago(48 * HOUR), ttlSec: 60 }),
      NOW,
    );
    expect(v.action).toBe('keep');
    expect(v.refused).toBe(true);
    expect(v.reason).toMatch(/product's own desktop/);
  });

  it('governs an ordinary sandbox display with the same inputs (the positive control)', () => {
    // Without this, the two refusals above would pass against a governor that
    // simply never acts on anything.
    const v = classifyDesktopSession(
      session({ display: ':110', scope: 'pot', lastActiveAt: ago(48 * HOUR), ttlSec: 60 }),
      NOW,
    );
    expect(v.action).toBe('reap');
    expect(v.refused).toBeUndefined();
  });
});

describe('classifyDesktopSession — the viewer hold is real but BOUNDED', () => {
  // The guest kind is the sharp case: its freeze threshold (20m) sits INSIDE the
  // viewer hold, so these two tests genuinely exercise the precedence rather than
  // passing because nothing was due yet.
  const watched = (inactiveSec: number) =>
    session({
      kind: 'vm-guest',
      viewerMode: 'watch',
      viewerActor: 'human',
      lastActiveAt: ago(inactiveSec),
    });

  it('does not freeze a desktop out from under someone watching it', () => {
    // 40 minutes: twice the guest freeze threshold, well inside the viewer hold.
    // frame-vnc binds the viewer when the stream OPENS and writes nothing until
    // teardown, so a quiet 40-minute binding is a person still watching — this is
    // the exact case a short hold got wrong.
    const v = classifyDesktopSession(watched(40 * MIN), NOW);
    expect(v.action).toBe('keep');
    expect(v.reason).toMatch(/viewer bound/);
  });

  it('freezes the SAME session once the binding outlives any plausible session', () => {
    // The bound exists because teardown can be skipped: a crashed viewer never
    // runs the clear, and an unbounded hold would leak the desktop forever.
    const v = classifyDesktopSession(watched(VIEWER_HOLD_SEC + MIN), NOW);
    expect(v.action).toBe('freeze');
  });

  it('the identical unwatched session freezes immediately (the positive control)', () => {
    // Without this, both assertions above would pass against a classifier that
    // simply never freezes a vm-guest.
    const v = classifyDesktopSession(
      session({ kind: 'vm-guest', lastActiveAt: ago(40 * MIN) }),
      NOW,
    );
    expect(v.action).toBe('freeze');
  });

  it('the viewer hold outlasts the freeze threshold of every kind', () => {
    // The invariant behind the sizing: if any kind could freeze before the hold
    // expires, a bound viewer would be honoured for some kinds and not others —
    // a difference nobody would predict from reading either constant alone.
    for (const [kind, p] of Object.entries(DESKTOP_LIFECYCLE_POLICY)) {
      expect(VIEWER_HOLD_SEC, `${kind} can freeze before the viewer hold expires`).toBeGreaterThan(
        p.idleAfterSec,
      );
    }
  });
});

describe('classifyDesktopSession — leases and stuck provisions', () => {
  it('reaps an expired lease regardless of where it sits on the ladder', () => {
    const v = classifyDesktopSession(
      session({ ttlSec: 10 * MIN, lastActiveAt: ago(11 * MIN) }),
      NOW,
    );
    expect(v.action).toBe('reap');
    expect(v.reason).toMatch(/lease expired/);
  });

  it('keeps a lease that is still inside its TTL even when idle', () => {
    const v = classifyDesktopSession(
      session({ ttlSec: 8 * HOUR, lastActiveAt: ago(20 * MIN) }),
      NOW,
    );
    expect(v.action).toBe('idle');
  });

  it('keeps a session that is still coming up', () => {
    const v = classifyDesktopSession(
      session({ state: 'provisioning', createdAt: ago(30), lastActiveAt: ago(30) }),
      NOW,
    );
    expect(v.action).toBe('keep');
    expect(v.reason).toBe('still provisioning');
  });

  it('reaps a session stuck in provisioning — it holds a display in the uniqueness index forever', () => {
    const v = classifyDesktopSession(
      session({
        state: 'provisioning',
        createdAt: ago(PROVISIONING_STUCK_SEC + 60),
        lastActiveAt: ago(PROVISIONING_STUCK_SEC + 60),
      }),
      NOW,
    );
    expect(v.action).toBe('reap');
    expect(v.reason).toMatch(/never came up/);
  });

  it('honours a per-session idle override ahead of the kind default', () => {
    const v = classifyDesktopSession(
      session({ idleAfterSec: 30, lastActiveAt: ago(60) }),
      NOW,
    );
    expect(v.action).toBe('idle');
  });
});

describe('per-kind policy — the WI-5978 asymmetry', () => {
  it('freezes a guest far sooner than an xvfb sandbox (an idle guest can burn a core)', () => {
    expect(policyFor('vm-guest').freezeAfterSec).toBeLessThan(
      policyFor('xvfb-local').freezeAfterSec,
    );
    expect(policyFor('microvm').freezeAfterSec).toBeLessThan(policyFor('bwrap').freezeAfterSec);
  });

  it('reaps a guest far LATER than an xvfb sandbox (its state is expensive to rebuild)', () => {
    expect(policyFor('vm-guest').reapAfterFrozenSec).toBeGreaterThan(
      policyFor('xvfb-local').reapAfterFrozenSec,
    );
  });

  it('the same age freezes a guest while leaving an xvfb desktop merely idle', () => {
    const at = { state: 'ready' as const, lastActiveAt: ago(45 * MIN) };
    expect(classifyDesktopSession(session({ ...at, kind: 'vm-guest' }), NOW).action).toBe('freeze');
    expect(classifyDesktopSession(session({ ...at, kind: 'xvfb-local' }), NOW).action).toBe('idle');
  });

  it('an unknown kind falls back to the CONSERVATIVE policy, never an aggressive one', () => {
    const fallback = policyFor('some-future-kind' as never);
    expect(fallback).toEqual(DEFAULT_DESKTOP_LIFECYCLE_POLICY);
    for (const known of Object.values(DESKTOP_LIFECYCLE_POLICY)) {
      expect(fallback.freezeAfterSec).toBeGreaterThanOrEqual(known.freezeAfterSec);
    }
  });

  it('every registry kind has an explicit policy entry', () => {
    // Not ceremony: a kind that silently falls back is a kind whose cost profile
    // nobody thought about. P-010 (bwrap) and P-011 (microvm) both land here.
    for (const kind of ['xvfb-local', 'frame-slot', 'vm-guest', 'bwrap', 'microvm'] as const) {
      expect(DESKTOP_LIFECYCLE_POLICY[kind]).toBeDefined();
    }
  });

  it('idle always precedes freeze, which always precedes reap', () => {
    for (const [kind, p] of Object.entries(DESKTOP_LIFECYCLE_POLICY)) {
      expect(p.idleAfterSec, kind).toBeLessThanOrEqual(p.freezeAfterSec);
      expect(p.reapAfterFrozenSec, kind).toBeGreaterThan(0);
    }
  });
});

describe('drift guard — the protected-display set', () => {
  it('matches gc-verify-instances, which is the other sweep that can tear down a display', () => {
    // The two sets are duplicated on purpose (neither sweep should be able to
    // widen the other's refusals by accident) — which is exactly why they need a
    // guard that notices when one of them changes and the other does not.
    const here = dirname(fileURLToPath(import.meta.url));
    const gc = readFileSync(join(here, '../harness/routines/gc-verify-instances.ts'), 'utf8');
    const declared = /PROTECTED_DISPLAYS\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(gc);
    expect(declared, 'gc-verify-instances no longer declares PROTECTED_DISPLAYS as a literal Set').toBeTruthy();
    const theirs = new Set(
      (declared?.[1] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean),
    );
    expect([...theirs].sort()).toEqual([...PROTECTED_DISPLAYS].sort());
  });
});
