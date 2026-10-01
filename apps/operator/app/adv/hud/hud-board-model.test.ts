/**
 * hud-board-model tests (adv-hud-fleet-board-2026-07-25 P-002).
 *
 * The precedence chain is the design, so it gets the most coverage: a session
 * can satisfy several column predicates at once and only ONE ordering is
 * correct. The `blocked` > `stalled` case matters most — mislabelling a
 * legitimately-gated agent as stalled would cry wolf on the signal the board
 * exists to make trustworthy.
 */

import { describe, it, expect } from 'vitest';
import { MODES, modeById } from '@papercusp/operator-core/lib/modes/registry';
import {
  buildHudBoard,
  contextPct,
  deriveBadges,
  deriveColumn,
  deriveFleetRollups,
  derivePlanRollups,
  formatAge,
  hasSessionChatSurface,
  HUD_DEFAULT_THRESHOLDS,
  isInfrastructureAwait,
  isSuSession,
  isZombieSession,
  matchesSessionText,
  parseHighlight,
  searchHitAnchor,
  fetchTranscriptSearch,
  rollUpTranscriptSearch,
  shortHandle,
  TERMINAL_LAUNCH_ONLINE_GRACE_SEC,
  toHudSession,
  unattributedAsks,
  ZOMBIE_REASON,
  type HudAsk,
  type HudRosterEntry,
  type HudSearchHit,
} from './hud-board-model';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const OPTS = { nowMs: NOW, thresholds: HUD_DEFAULT_THRESHOLDS };

describe('card headline — sessionDisplayName (hud-session-display-names P-005, D-001/D-003)', () => {
  it('prefers a manual name, then the objective, then the short handle', () => {
    const named = toHudSession(entry({ displayName: 'release wrangler' }), undefined, OPTS);
    expect(named.displayName).toBe('release wrangler');
    expect(named.displayNameSource).toBe('manual');

    const objective = toHudSession(entry({ objective: 'Green the checkpoint gate' }), undefined, OPTS);
    expect(objective.displayName).toBe('Green the checkpoint gate');
    expect(objective.displayNameSource).toBe('objective');

    const bare = toHudSession(entry({ intent: '', objective: null }), undefined, OPTS);
    expect(bare.displayName).toBe(bare.handle);
    expect(bare.displayNameSource).toBe('handle');
  });

  it('falls back to the handle in the BOARD id format, not the terminal one', () => {
    // The card prints `handle` on its dim secondary row; a headline resolved to a
    // DIFFERENT shortening of the same id would read as two different sessions.
    const bare = toHudSession(entry({ intent: '', objective: null }), undefined, OPTS);
    expect(bare.displayName).toBe('su-11112222');
    expect(bare.handle).toBe('su-11112222');
  });

  it('keeps the short id on the card — the headline never replaces it (D-001)', () => {
    const s = toHudSession(entry({ displayName: 'release wrangler' }), undefined, OPTS);
    expect(s.handle).toBe('su-11112222');
    expect(s.displayName).not.toBe(s.handle);
  });

  it('an older payload with no `objective` still resolves via the declared intent', () => {
    // objective is optional precisely so a mid-deploy SSE push renders as before
    const s = toHudSession(entry({}), undefined, OPTS);
    expect(s.displayName).toBe('greening the release gate');
    expect(s.displayNameSource).toBe('objective');
  });

  it('carries the work-item ref only when the roster resolved one', () => {
    expect(toHudSession(entry({ objectiveWorkItemRef: 'WI-42' }), undefined, OPTS).objectiveWorkItemRef).toBe(
      'WI-42',
    );
    expect(toHudSession(entry({}), undefined, OPTS).objectiveWorkItemRef).toBeNull();
  });

  it('a blank manual name is cleared, not an empty headline (R6)', () => {
    const s = toHudSession(entry({ displayName: '   ' }), undefined, OPTS);
    expect(s.displayName).toBe('greening the release gate');
    expect(s.displayNameSource).toBe('objective');
  });
});

describe('matchesSessionText — a named session is findable by its name (R7)', () => {
  it('matches the manual name, the objective, and the work-item ref', () => {
    const e = entry({
      displayName: 'release wrangler',
      objective: 'Green the checkpoint gate',
      objectiveWorkItemRef: 'WI-42',
    });
    expect(matchesSessionText(e, 'wrangler')).toBe(true);
    expect(matchesSessionText(e, 'RELEASE WRANGLER')).toBe(true);
    expect(matchesSessionText(e, 'checkpoint')).toBe(true);
    expect(matchesSessionText(e, 'WI-42')).toBe(true);
    expect(matchesSessionText(e, 'not-in-this-session')).toBe(false);
  });

  it('an unnamed session is unaffected', () => {
    expect(matchesSessionText(entry({}), 'greening')).toBe(true);
    expect(matchesSessionText(entry({}), 'wrangler')).toBe(false);
  });
});

function entry(over: Partial<HudRosterEntry> = {}): HudRosterEntry {
  return {
    ownerId: 'su-11112222-3333-4444-5555-666677778888',
    label: 'su · su-11112',
    source: 'omp-hook-session',
    intent: 'greening the release gate',
    currentFiles: [],
    liveness: 'live',
    stale: false,
    lastActiveAt: iso(5_000),
    intentDeclaredAt: iso(60_000),
    loopArmed: false,
    modes: [],
    pidAlive: true,
    claims: [],
    declaredUnclaimed: false,
    currentPlanSlug: null,
    harnessSlug: null,
    agentPaneKind: 'su',
    role: 'su',
    agent: 'claude',
    advSessionId: 7,
    windowId: null,
    wakeMode: 'auto',
    pendingWakes: 0,
    fleetSlug: null,
    fleetColor: null,
    fleetRole: null,
    contextTokens: null,
    compactionLimit: null,
    openAwait: null,
    transcriptFresh: false,
    thinking: false,
    ...over,
  };
}

const ask = (over: Partial<HudAsk> = {}): HudAsk => ({
  ownerAgentId: 'su-11112222-3333-4444-5555-666677778888',
  title: 'Drop the legacy shim, or migrate the 4 callers?',
  occurredAt: iso(12 * 60_000),
  id: 'work-item-needs-human:WI-1',
  kind: 'work-item-needs-human',
  itemRef: null,
  planSlug: null,
  harnessSlug: 'papercusp',
  ...over,
});

describe('shortHandle', () => {
  it('trims a uuid owner id to its readable leading segment', () => {
    expect(shortHandle('su-709bb0d6-12de-465e-bb82-0f4bb282c87a')).toBe('su-709bb0d6');
  });
  it('leaves an already-short id alone', () => {
    expect(shortHandle('su-abc')).toBe('su-abc');
  });
  it('truncates an unrecognised long id rather than overflowing a card', () => {
    expect(shortHandle('a'.repeat(40))).toHaveLength(17); // 16 + ellipsis
  });
});

describe('hasSessionChatSurface', () => {
  it('keeps every supported runtime and partial legacy rows on the shared surface', () => {
    expect(hasSessionChatSurface('claude')).toBe(true);
    expect(hasSessionChatSurface('papercup')).toBe(true);
    expect(hasSessionChatSurface('codex')).toBe(true);
    expect(hasSessionChatSurface('OMP')).toBe(true);
    expect(hasSessionChatSurface(null)).toBe(true);
    expect(hasSessionChatSurface(undefined)).toBe(true);
  });

  it('keeps an actually unsupported future runtime from promising a popup', () => {
    const agent = 'future-runtime';
    expect(hasSessionChatSurface(agent)).toBe(false);
  });
});

describe('contextPct', () => {
  it('computes a percentage from tokens and limit', () => {
    expect(contextPct(120_000, 200_000)).toBe(60);
  });
  it('returns null — never 0 — when either input is unknown', () => {
    // 0 would render as "plenty of room left", the exact opposite of "unknown".
    expect(contextPct(null, 200_000)).toBeNull();
    expect(contextPct(120_000, null)).toBeNull();
  });
  it('guards a zero/negative limit instead of dividing by it', () => {
    expect(contextPct(10, 0)).toBeNull();
  });
  it('clamps a context that has overrun its limit', () => {
    expect(contextPct(300_000, 200_000)).toBe(100);
  });
});

describe('formatAge', () => {
  it('scales the unit with the magnitude', () => {
    expect(formatAge(40)).toBe('40s');
    expect(formatAge(12 * 60)).toBe('12m');
    expect(formatAge(3 * 3600)).toBe('3h');
    expect(formatAge(2 * 86400)).toBe('2d');
  });
  it('renders unknown as an em dash, not "0s"', () => {
    expect(formatAge(null)).toBe('—');
  });
});

describe('isSuSession', () => {
  it('accepts an su pane kind and rejects a nursery cup', () => {
    expect(isSuSession(entry({ agentPaneKind: 'su' }))).toBe(true);
    expect(isSuSession(entry({ agentPaneKind: 'cup' }))).toBe(false);
    expect(isSuSession(entry({ agentPaneKind: 'mug' }))).toBe(false);
  });
});

describe('deriveColumn — precedence', () => {
  it('routes an unanswered ask to needs-you, dated from the ask', () => {
    const v = deriveColumn(entry(), [ask()], OPTS);
    expect(v.column).toBe('needs-you');
    expect(v.reason).toContain('legacy shim');
    expect(v.sinceSec).toBe(12 * 60);
  });

  it('picks the OLDEST ask when several are outstanding', () => {
    const v = deriveColumn(
      entry(),
      [ask({ title: 'recent', occurredAt: iso(60_000) }), ask({ title: 'oldest', occurredAt: iso(30 * 60_000) })],
      OPTS,
    );
    expect(v.reason).toBe('oldest');
    expect(v.sinceSec).toBe(30 * 60);
  });

  it('treats a staged manual-mode wake as needs-you — the message is undelivered', () => {
    const v = deriveColumn(entry({ pendingWakes: 2, wakeMode: 'manual' }), undefined, OPTS);
    expect(v.column).toBe('needs-you');
    expect(v.reason).toContain('2 wakes staged');
  });

  it('needs-you OUTRANKS blocked — a gated agent that also asked you is yours first', () => {
    const v = deriveColumn(
      entry({ openAwait: { eventKey: 'fleet:gate', note: null, sinceIso: iso(60 * 60_000), expiresIso: null } }),
      [ask()],
      OPTS,
    );
    expect(v.column).toBe('needs-you');
  });

  it('routes an open await to blocked, naming the gate and how long it has waited', () => {
    const v = deriveColumn(
      entry({
        openAwait: {
          eventKey: 'fleet:release-gate:suite-green',
          note: null,
          sinceIso: iso(41 * 60_000),
          expiresIso: null,
        },
      }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('blocked');
    expect(v.reason).toBe('Waiting on fleet:release-gate:suite-green');
    expect(v.sinceSec).toBe(41 * 60);
  });

  it("prefers the agent's own note over the raw key, keeping the key for reference", () => {
    const v = deriveColumn(
      entry({
        openAwait: {
          eventKey: 'fleet:gate',
          note: 'waiting for the suite verdict',
          sinceIso: iso(1000),
          expiresIso: null,
        },
      }),
      undefined,
      OPTS,
    );
    expect(v.reason).toBe('waiting for the suite verdict (fleet:gate)');
  });

  it('does NOT treat the always-armed inbox wake as a block', () => {
    // The single most important guard in this file. Every agent carries a
    // permanent `coord:inbox-wake:<self>` await (migration 183) meaning "I am
    // reachable" — the opposite of blocked. Measured live on 2026-07-25 while
    // building this board: 126 of 139 open awaits were inbox-wakes, one per
    // agent, against 13 real gates. Counting them put ~93% of the roster in
    // Blocked, which does not merely add noise — it destroys the column, since
    // a signal that fires for nearly everyone distinguishes no one.
    const v = deriveColumn(
      entry({
        openAwait: {
          eventKey: 'coord:inbox-wake:su-11112222-3333-4444-5555-666677778888',
          note: null,
          sinceIso: iso(3 * 60 * 60_000),
          expiresIso: null,
        },
      }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('working');
  });

  it('classifies infrastructure vs real gates', () => {
    expect(isInfrastructureAwait({ eventKey: 'coord:inbox-wake:su-1', note: null, sinceIso: iso(0), expiresIso: null })).toBe(true);
    // Real gates seen live: work-item:*, gate-first-green, composed-root.
    expect(isInfrastructureAwait({ eventKey: 'work-item:done:WI-5779', note: null, sinceIso: iso(0), expiresIso: null })).toBe(false);
    expect(isInfrastructureAwait({ eventKey: 'gate-first-green', note: null, sinceIso: iso(0), expiresIso: null })).toBe(false);
    expect(isInfrastructureAwait(null)).toBe(false);
  });

  it('still blocks on a real gate held by an agent that also has an inbox wake', () => {
    // The server picks the OLDEST non-inbox await, so a real gate must survive.
    const v = deriveColumn(
      entry({
        openAwait: { eventKey: 'work-item:done:WI-5779', note: null, sinceIso: iso(20 * 60_000), expiresIso: null },
      }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('blocked');
    expect(v.reason).toContain('work-item:done:WI-5779');
  });

  it('does not block an ended session on a stale real-gate await', () => {
    // openAwaitsByOwner joins awaits by owner id for every presence row. The
    // liveness oracle is authoritative for whether that owner can still be
    // parked on the gate; an ended session's leftover await is not a live block.
    const v = deriveColumn(
      entry({
        sessionState: 'ended',
        liveness: 'live',
        lastActiveAt: iso(2 * 60 * 60_000),
        intentDeclaredAt: iso(2 * 60 * 60_000),
        openAwait: {
          eventKey: 'fleet:release-gate:suite-green',
          note: 'waiting for the suite verdict',
          sinceIso: iso(60 * 60_000),
          expiresIso: null,
        },
      }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('parked');
    expect(v.reason).toBe('No heartbeat — session has ended');
  });

  it('blocked OUTRANKS stalled — a gated agent is behaving correctly, not stuck', () => {
    // This entry satisfies every stall predicate: no activity for an hour and an
    // intent two hours old. It is still Blocked, because it is *waiting on
    // purpose*. Calling it stalled is the false positive that would make the
    // stall column untrustworthy.
    const v = deriveColumn(
      entry({
        lastActiveAt: iso(60 * 60_000),
        intentDeclaredAt: iso(120 * 60_000),
        openAwait: { eventKey: 'fleet:gate', note: null, sinceIso: iso(60 * 60_000), expiresIso: null },
      }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('blocked');
  });

  it('flags stalled only when BOTH the activity and intent clocks are dead', () => {
    const stalled = deriveColumn(
      entry({ lastActiveAt: iso(20 * 60_000), intentDeclaredAt: iso(40 * 60_000) }),
      undefined,
      OPTS,
    );
    expect(stalled.column).toBe('stalled');
    expect(stalled.reason).toContain('No tool call in 20m');
  });

  it('does NOT call a long task with fresh tool calls stalled', () => {
    // Old intent (one long job) but active 5s ago — this is working, and
    // labelling it stalled is the other way to make the column useless.
    const v = deriveColumn(
      entry({ lastActiveAt: iso(5_000), intentDeclaredAt: iso(90 * 60_000) }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('working');
  });

  it('does NOT call a quiet-but-recently-redeclared agent stalled', () => {
    const v = deriveColumn(
      entry({ lastActiveAt: iso(20 * 60_000), intentDeclaredAt: iso(60_000) }),
      undefined,
      OPTS,
    );
    expect(v.column).not.toBe('stalled');
  });

  it('reports a zombie (fresh heartbeat, dead process) as stalled with its own reason', () => {
    const v = deriveColumn(entry({ pidAlive: false, liveness: 'live' }), undefined, OPTS);
    expect(v.column).toBe('stalled');
    expect(v.reason).toContain('zombie');
  });

  it('keeps a loop-armed agent working through the idle gap between wakes', () => {
    const v = deriveColumn(
      entry({ liveness: 'idle', loopArmed: true, lastActiveAt: iso(30_000), intentDeclaredAt: iso(30_000) }),
      undefined,
      OPTS,
    );
    expect(v.column).toBe('working');
  });

  /**
   * WI-6636 — the default board read "Stalled 110" of 133 cards, median 2 days
   * and up to 11 days stale, while coord:presence called the same population
   * live 5 / parked 123. Cause: `liveness` is HEARTBEAT freshness, and a parked
   * agent waiting on its inbox keeps beating, so it read 'live' forever and
   * then tripped the stall clocks. The board asserted the system was mostly
   * stuck when it was mostly idle.
   *
   * These cases pin the fix in BOTH directions: the false positive must go, and
   * the genuine stalls the column exists for must survive.
   */
  describe('sessionState (the shared liveness oracle) governs "nominally alive"', () => {
    /** The exact 110-card shape: parked per the oracle, dead clocks, fresh heartbeat. */
    const parkedAndQuiet = {
      sessionState: 'parked',
      liveness: 'live' as const,
      stale: false,
      lastActiveAt: iso(2 * 24 * 60 * 60_000),
      intentDeclaredAt: iso(2 * 24 * 60 * 60_000),
    };

    it('does NOT call a parked agent stalled, however long it has been quiet', () => {
      const v = deriveColumn(entry(parkedAndQuiet), undefined, OPTS);
      expect(v.column).not.toBe('stalled');
    });

    it('parks it — the half that makes the fix safe, rather than inflating "working"', () => {
      // Dropping these out of `stalled` without also teaching step 4 the oracle
      // would send all 110 into `working`: `liveness` reads 'live' for every one
      // of them. A board that overstates progress is worse than one that
      // overstates stalls, so this assertion is the real regression guard.
      const v = deriveColumn(entry(parkedAndQuiet), undefined, OPTS);
      expect(v.column).toBe('parked');
      expect(v.reason).toContain('Idle between turns');
    });

    it('STILL flags a genuinely live agent that stopped moving', () => {
      // The column's whole purpose. The oracle says a turn is in flight, but the
      // activity and intent clocks are both dead — that is a real stall.
      const v = deriveColumn(
        entry({
          sessionState: 'live',
          lastActiveAt: iso(20 * 60_000),
          intentDeclaredAt: iso(40 * 60_000),
        }),
        undefined,
        OPTS,
      );
      expect(v.column).toBe('stalled');
      expect(v.reason).toContain('No tool call in 20m');
    });

    it('STILL flags an armed loop that is not producing turns, even when parked', () => {
      // A loop is SUPPOSED to produce turns on a cadence, so an armed loop with a
      // dead activity clock is a dead loop — the sharpest genuine stall here, and
      // it must not be swept up by the parked exemption above.
      const v = deriveColumn(
        entry({
          ...parkedAndQuiet,
          loopArmed: true,
        }),
        undefined,
        OPTS,
      );
      expect(v.column).toBe('stalled');
    });

    it('falls back to the heartbeat legs when the oracle has no verdict', () => {
      // null/absent means UNKNOWN (older payload, or a degraded fetch) — never
      // "not live". Guessing would silently empty the column and hide a real
      // stall, so an unknown verdict must classify exactly as it did before.
      for (const unknown of [undefined, null]) {
        const v = deriveColumn(
          entry({
            sessionState: unknown,
            lastActiveAt: iso(20 * 60_000),
            intentDeclaredAt: iso(40 * 60_000),
          }),
          undefined,
          OPTS,
        );
        expect(v.column).toBe('stalled');
      }
    });

    it('treats a `recorded` session with no live turn as parked, not working', () => {
      // `recorded` means the session log says the process exists, not that a
      // turn is in flight. It is a liveness verdict, not an activity override.
      const v = deriveColumn(
        entry({
          sessionState: 'recorded',
          liveTurn: false,
          lastActiveAt: iso(5_000),
          intentDeclaredAt: iso(60_000),
        }),
        undefined,
        OPTS,
      );
      expect(v.column).toBe('parked');
    });

    it('does not let transcript freshness override a parked oracle verdict', () => {
      const v = deriveColumn(
        entry({
          sessionState: 'parked',
          liveTurn: false,
          transcriptFresh: true,
          liveness: 'live',
          lastActiveAt: iso(5_000),
        }),
        undefined,
        OPTS,
      );
      expect(v.column).toBe('parked');
    });

    it('keeps transcript freshness only as an older-payload fallback', () => {
      const v = deriveColumn(
        entry({
          sessionState: null,
          liveTurn: null,
          transcriptFresh: true,
          liveness: 'idle',
          lastActiveAt: iso(5_000),
        }),
        undefined,
        OPTS,
      );
      expect(v.column).toBe('working');
    });
  });

  it('parks an idle session, and distinguishes ended from not-yet-started', () => {
    expect(deriveColumn(entry({ liveness: 'idle', lastActiveAt: iso(120_000), intentDeclaredAt: iso(120_000) }), undefined, OPTS).column).toBe('parked');
    expect(deriveColumn(entry({ liveness: 'stale', stale: true }), undefined, OPTS).reason).toContain('ended');
    expect(deriveColumn(entry({ liveness: 'pending' }), undefined, OPTS).reason).toContain('not started');
  });

  /**
   * Owner ask 2026-07-27: "all fresh sessions start as needs you". A just-launched
   * session used to land in `parked`, which read as "idle, fine" for the one case
   * where the human is the only thing that can move it forward.
   */
  describe('fresh sessions (never taken a turn)', () => {
    it('puts a pending launch in needs-you, not parked', () => {
      const v = deriveColumn(entry({ liveness: 'pending', lastActiveAt: null }), undefined, OPTS);
      expect(v.column).toBe('needs-you');
      expect(v.reason).toMatch(/Fresh session/);
      expect(v.reason).toMatch(/not started yet/);
    });

    it('puts a booted-but-never-active session in needs-you too', () => {
      const v = deriveColumn(entry({ liveness: 'live', lastActiveAt: null }), undefined, OPTS);
      expect(v.column).toBe('needs-you');
      expect(v.reason).toMatch(/no turn taken yet/);
    });

    it('does NOT call a never-active session that has since DIED fresh — that one is parked', () => {
      // The column's value is that everything in it is actionable; a dead session
      // is not, however little it ever ran.
      expect(deriveColumn(entry({ liveness: 'stale', stale: true, lastActiveAt: null }), undefined, OPTS).column).toBe(
        'parked',
      );
      expect(deriveColumn(entry({ liveness: 'stale', stale: false, lastActiveAt: null }), undefined, OPTS).column).toBe(
        'parked',
      );
    });

    it('still shows a real ask ahead of the generic fresh reason', () => {
      const v = deriveColumn(entry({ liveness: 'pending', lastActiveAt: null }), [ask()], OPTS);
      expect(v.column).toBe('needs-you');
      expect(v.reason).not.toMatch(/Fresh session/);
    });

    it('reports a terminal launch that never came online as a FAILED launch, not as fresh (WI-6376)', () => {
      const v = deriveColumn(
        entry({
          liveness: 'pending',
          lastActiveAt: null,
          display: 'terminal',
          startedAt: iso(TERMINAL_LAUNCH_ONLINE_GRACE_SEC * 1000 + 5_000),
        }),
        undefined,
        OPTS,
      );
      // Still the human's to fix — but the card must stop implying a healthy
      // session is on its way.
      expect(v.column).toBe('needs-you');
      expect(v.reason).toMatch(/never came online/);
      expect(v.reason).not.toMatch(/Fresh session/);
      expect(v.sinceSec).toBeGreaterThanOrEqual(TERMINAL_LAUNCH_ONLINE_GRACE_SEC);
    });

    it('still calls a terminal launch INSIDE the grace window a fresh session', () => {
      const v = deriveColumn(
        entry({
          liveness: 'pending',
          lastActiveAt: null,
          display: 'terminal',
          startedAt: iso(5_000),
        }),
        undefined,
        OPTS,
      );
      expect(v.column).toBe('needs-you');
      expect(v.reason).toMatch(/Fresh session/);
      expect(v.reason).not.toMatch(/never came online/);
    });

    it('reports a recognized live provider wall immediately, with its remediation', () => {
      const hint =
        "Claude's weekly usage limit was reached; it resets 7am. " +
        'Launch with Codex or an available account, or retry after the reset.';
      const v = deriveColumn(
        entry({
          liveness: 'pending',
          lastActiveAt: null,
          display: 'terminal',
          startedAt: iso(5_000),
          launchBlocked: true,
          launchBlockedHint: hint,
        }),
        undefined,
        OPTS,
      );
      expect(v.column).toBe('needs-you');
      expect(v.reason).toBe(hint);
      expect(v.reason).not.toMatch(/Fresh session/);
      expect(v.reason).not.toMatch(/terminal closed/i);
    });

    it('keeps observed launch death distinct from a live provider blockage', () => {
      const v = deriveColumn(
        entry({
          liveness: 'pending',
          lastActiveAt: null,
          display: 'terminal',
          startedAt: iso(5_000),
          launchFailed: true,
          launchBlocked: false,
        }),
        undefined,
        OPTS,
      );
      expect(v.column).toBe('needs-you');
      expect(v.reason).toMatch(/Launch failed/);
      expect(v.reason).not.toMatch(/provider limit/);
      expect(v.reason).not.toMatch(/Fresh session/);
    });

    it('never applies the failed-launch reason to a WORKBENCH pending launch', () => {
      // Non-vacuity guard on the `display` discriminator: same age, other tier.
      const v = deriveColumn(
        entry({
          liveness: 'pending',
          lastActiveAt: null,
          display: 'workbench',
          startedAt: iso(TERMINAL_LAUNCH_ONLINE_GRACE_SEC * 1000 + 5_000),
        }),
        undefined,
        OPTS,
      );
      expect(v.reason).toMatch(/Fresh session/);
      expect(v.reason).not.toMatch(/never came online/);
    });

    it('leaves a session that HAS taken a turn classified exactly as before', () => {
      // Non-vacuity guard: the same accessor returns a different column once
      // lastActiveAt is set, so the assertions above cannot be passing trivially.
      expect(deriveColumn(entry({ liveness: 'live' }), undefined, OPTS).column).toBe('working');
      expect(
        deriveColumn(entry({ liveness: 'idle', lastActiveAt: iso(120_000), intentDeclaredAt: iso(120_000) }), undefined, OPTS)
          .column,
      ).toBe('parked');
    });
  });
});

describe('deriveBadges', () => {
  it('carries native agent kind and chat support into the card model', () => {
    const session = toHudSession(entry({ agent: 'omp' }), undefined, OPTS);
    expect(session.agent).toBe('omp');
    expect(session.chatSupported).toBe(true);
    expect(toHudSession(entry({ agent: 'codex' }), undefined, OPTS).chatSupported).toBe(true);
    expect(toHudSession(entry({ agent: 'papercup' }), undefined, OPTS).chatSupported).toBe(true);
  });

  it('does NOT badge fleet leadership — that is identity, rendered beside the handle', () => {
    // Emitting it here too rendered "LEAD" twice on every leader card and burnt
    // one of the capped badge slots. `isLeader` on the session carries it.
    const b = deriveBadges(entry({ fleetRole: 'leader', fleetSlug: 'atlas' }), OPTS);
    expect(b.find((x) => x.id === 'lead')).toBeUndefined();
    expect(toHudSession(entry({ fleetRole: 'leader' }), undefined, OPTS).isLeader).toBe(true);
  });

  it('surfaces standing modes with an explanation of what they mean for the human', () => {
    const b = deriveBadges(
      entry({ modes: [{ mode: 'auto' }, { mode: 'ideate' }] }),
      OPTS,
    );
    expect(b.map((x) => x.label)).toEqual(expect.arrayContaining(['AUTO', 'IDEATE']));
    expect(b.find((x) => x.id === 'mode-auto')?.title).toContain(modeById('auto')!.oneLiner);
  });

  // The hand-written label/title map this replaced covered auto/ideate/drain
  // only, so `cold-auto` and `grade` rendered "Standing mode: grade" — a chip
  // that names a thing and explains nothing. Deriving from the registry means a
  // mode added there is explained the same day; this fails if that regresses.
  it('explains EVERY registered mode, not just the three someone wrote copy for', () => {
    for (const def of MODES) {
      const chip = deriveBadges(entry({ modes: [{ mode: def.id }] }), OPTS).find(
        (x) => x.id === `mode-${def.id}`,
      );
      expect(chip, def.id).toBeDefined();
      expect(chip!.title, def.id).toContain(def.oneLiner);
      expect(chip!.title, def.id).not.toContain('Standing mode:');
      // 'cold-auto' must read as a label, not an id.
      expect(chip!.label, def.id).toBe(def.id.toUpperCase().replace(/-/g, ' '));
    }
  });

  // Provenance is the half that makes the chip actionable: "it is in AUTO because
  // I put it there" (sticky against peers) vs "it put ITSELF in AUTO".
  it('distinguishes an owner-armed mode from one the agent set itself', () => {
    const owner = deriveBadges(entry({ modes: [{ mode: 'auto', ownerDirected: true }] }), OPTS)
      .find((x) => x.id === 'mode-auto')!;
    const self = deriveBadges(entry({ modes: [{ mode: 'auto', ownerDirected: false }] }), OPTS)
      .find((x) => x.id === 'mode-auto')!;
    expect(owner.ownerDirected).toBe(true);
    expect(owner.title).toContain('Set by the owner');
    expect(self.ownerDirected).toBe(false);
    expect(self.title).toContain('set this itself');
  });

  // A payload from an operator predating the provenance upgrade (federation, or a
  // mid-deploy SSE push) still carries bare strings. Render chips, don't throw.
  it('tolerates the legacy bare-string mode payload', () => {
    const b = deriveBadges(entry({ modes: ['drain'] }), OPTS);
    const chip = b.find((x) => x.id === 'mode-drain');
    expect(chip?.label).toBe('DRAIN');
    expect(chip?.ownerDirected).toBe(false);
  });

  it('marks mode chips as modes so the card can exempt them from the chip cap', () => {
    const b = deriveBadges(entry({ modes: [{ mode: 'auto' }], claims: [{ status: 'wip' }] }), OPTS);
    expect(b.find((x) => x.id === 'mode-auto')?.kind).toBe('mode');
    expect(b.find((x) => x.id === 'claims')?.kind).not.toBe('mode');
  });

  it('shows claim progress and turns good when the lane is complete', () => {
    const b = deriveBadges(
      entry({ claims: [{ status: 'done' }, { status: 'done' }, { status: 'wip' }] }),
      OPTS,
    );
    const chip = b.find((x) => x.id === 'claims');
    expect(chip?.label).toBe('2/3');
    expect(chip?.tone).toBe('neutral');
    const all = deriveBadges(entry({ claims: [{ status: 'done' }] }), OPTS).find((x) => x.id === 'claims');
    expect(all?.tone).toBe('good');
  });

  it('shows context only once it matters, escalating to bad past the critical band', () => {
    expect(deriveBadges(entry({ contextTokens: 20_000, compactionLimit: 200_000 }), OPTS).find((x) => x.id === 'ctx')).toBeUndefined();
    expect(deriveBadges(entry({ contextTokens: 130_000, compactionLimit: 200_000 }), OPTS).find((x) => x.id === 'ctx')?.tone).toBe('warn');
    expect(deriveBadges(entry({ contextTokens: 180_000, compactionLimit: 200_000 }), OPTS).find((x) => x.id === 'ctx')?.tone).toBe('bad');
  });

  it('warns on manual wake mode — the difference between ignored and never heard', () => {
    const chip = deriveBadges(entry({ wakeMode: 'manual' }), OPTS).find((x) => x.id === 'wake');
    expect(chip?.tone).toBe('warn');
    expect(chip?.title).toContain('staged');
  });

  /**
   * popup-agent-state-coverage-2026-08-18 P-007. `pendingWakes` rode on the
   * roster row and was rendered nowhere, so the badge could say the staging
   * mechanism was armed but never that anything was caught in it.
   */
  it('carries the STAGED COUNT in the manual-wake badge, and stays silent at zero', () => {
    const armedOnly = deriveBadges(entry({ wakeMode: 'manual', pendingWakes: 0 }), OPTS).find(
      (x) => x.id === 'wake',
    );
    // 0 is a real state (armed, nothing caught) — it must not render "0 staged",
    // which reads as a defect report rather than as the normal case.
    expect(armedOnly?.label).toBe('wake: manual');

    const staged = deriveBadges(entry({ wakeMode: 'manual', pendingWakes: 3 }), OPTS).find(
      (x) => x.id === 'wake',
    );
    expect(staged?.label).toBe('wake: manual · 3 staged');
    expect(staged?.title).toContain('3 messages staged');

    // Singular, because "1 messages" on the surface a human reads to decide
    // whether their message landed is exactly where sloppiness costs trust.
    const one = deriveBadges(entry({ wakeMode: 'manual', pendingWakes: 1 }), OPTS).find(
      (x) => x.id === 'wake',
    );
    expect(one?.label).toBe('wake: manual · 1 staged');
    expect(one?.title).toContain('1 message staged');
  });

  /** An AUTO-wake session delivers immediately; a staged count there would be
   *  meaningless, and the badge does not exist at all. */
  it('emits no wake badge for an auto-wake session, whatever pendingWakes says', () => {
    expect(
      deriveBadges(entry({ wakeMode: 'auto', pendingWakes: 4 }), OPTS).find((x) => x.id === 'wake'),
    ).toBeUndefined();
  });
});

/**
 * popup-agent-state-coverage-2026-08-18 P-006. Extracted from `deriveColumn` so
 * the conversation popup renders the identical verdict in the identical words;
 * these assert the extraction preserved the rule, including its two guards.
 */
describe('isZombieSession', () => {
  it('fires on a nominally-alive session whose OS process is gone', () => {
    expect(isZombieSession(entry({ sessionState: 'live', pidAlive: false, stale: false }))).toBe(true);
  });

  it('does NOT fire on a stale row — already known-gone, and reported as such', () => {
    // Redundant noise on the one signal that has to stay sharp.
    expect(isZombieSession(entry({ sessionState: 'live', pidAlive: false, stale: true }))).toBe(false);
  });

  it('does NOT fire on pidAlive:null — "could not check" is not a death claim', () => {
    // null is a different host, no pid, or a stale entry. Treating it as false
    // would put a confident ☠ on every federated peer on the board.
    expect(isZombieSession(entry({ sessionState: 'live', pidAlive: null, stale: false }))).toBe(false);
  });

  it('does NOT fire on a parked session — it is not supposed to be producing turns', () => {
    expect(isZombieSession(entry({ sessionState: 'parked', loopArmed: false, pidAlive: false }))).toBe(
      false,
    );
  });

  it('DOES fire on a parked session with an armed loop — a dead loop is the sharpest stall', () => {
    expect(isZombieSession(entry({ sessionState: 'parked', loopArmed: true, pidAlive: false }))).toBe(
      true,
    );
  });

  it('falls back to the heartbeat legs when the oracle had no verdict', () => {
    // An unknown verdict must never silently suppress a real zombie.
    expect(
      isZombieSession(entry({ sessionState: null, liveness: 'live', pidAlive: false, stale: false })),
    ).toBe(true);
  });

  it('and deriveColumn reports it with the SAME exported wording', () => {
    const v = deriveColumn(entry({ sessionState: 'live', pidAlive: false }), undefined, OPTS);
    expect(v.column).toBe('stalled');
    expect(v.reason).toBe(ZOMBIE_REASON);
  });

  it('flags a declared-but-unclaimed lane', () => {
    const chip = deriveBadges(entry({ declaredUnclaimed: true, currentPlanSlug: 'p' }), OPTS).find((x) => x.id === 'unclaimed');
    expect(chip?.tone).toBe('warn');
  });
});

describe('deriveFleetRollups', () => {
  const mk = (over: Partial<HudRosterEntry>) => toHudSession(entry(over), undefined, OPTS);

  it('groups by fleet, records the leader, and counts per column', () => {
    const sessions = [
      mk({ ownerId: 'su-aaaaaaaa-1', fleetSlug: 'atlas', fleetRole: 'leader' }),
      mk({ ownerId: 'su-bbbbbbbb-2', fleetSlug: 'atlas', fleetRole: 'member' }),
      mk({
        ownerId: 'su-cccccccc-3',
        fleetSlug: 'atlas',
        fleetRole: 'member',
        openAwait: { eventKey: 'g', note: null, sinceIso: iso(1000), expiresIso: null },
      }),
    ];
    const [atlas] = deriveFleetRollups(sessions);
    expect(atlas.total).toBe(3);
    expect(atlas.leaderOwnerId).toBe('su-aaaaaaaa-1');
    expect(atlas.byColumn.blocked).toBe(1);
    expect(atlas.warning).toBe('1 blocked');
  });

  it('stays silent when a fleet is healthy — an absent warning is meaningful', () => {
    const [g] = deriveFleetRollups([mk({ fleetSlug: 'atlas', fleetRole: 'leader' })]);
    expect(g.warning).toBeNull();
  });

  it('calls out a leaderless fleet — nobody can reclaim claims or open its gates', () => {
    const [g] = deriveFleetRollups([mk({ fleetSlug: 'atlas', fleetRole: 'member' })]);
    expect(g.warning).toBe('no leader');
  });

  it('does not demand a leader for the solo group', () => {
    const [g] = deriveFleetRollups([mk({ fleetSlug: null })]);
    expect(g.warning).toBeNull();
  });

  it('sorts the neediest fleet first and solo last', () => {
    const rollups = deriveFleetRollups([
      mk({ ownerId: 'su-11111111-a', fleetSlug: null }),
      mk({ ownerId: 'su-22222222-b', fleetSlug: 'calm', fleetRole: 'leader' }),
      mk({
        ownerId: 'su-33333333-c',
        fleetSlug: 'busy',
        fleetRole: 'leader',
        openAwait: { eventKey: 'g', note: null, sinceIso: iso(1000), expiresIso: null },
      }),
    ]);
    expect(rollups.map((r) => r.label)).toEqual(['busy', 'calm', 'solo']);
  });
});

describe('derivePlanRollups (P-004)', () => {
  const mk = (over: Partial<HudRosterEntry>) => toHudSession(entry(over), undefined, OPTS);

  it('groups by plan and counts per column', () => {
    const rollups = derivePlanRollups([
      mk({ ownerId: 'su-aaaaaaaa-1', currentPlanSlug: 'alpha' }),
      mk({ ownerId: 'su-bbbbbbbb-2', currentPlanSlug: 'alpha' }),
      mk({
        ownerId: 'su-cccccccc-3',
        currentPlanSlug: 'alpha',
        openAwait: { eventKey: 'g', note: null, sinceIso: iso(1000), expiresIso: null },
      }),
    ]);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].total).toBe(3);
    expect(rollups[0].byColumn.blocked).toBe(1);
    expect(rollups[0].warning).toBe('1 blocked');
  });

  it('stays silent when a plan is healthy', () => {
    const [g] = derivePlanRollups([mk({ currentPlanSlug: 'alpha' })]);
    expect(g.warning).toBeNull();
  });

  // A plan has no leader, so the fleet rollup's "no leader" warning must NOT
  // come along for the ride — it would be chrome that lies.
  it('never invents a leaderless warning for a plan', () => {
    const [g] = derivePlanRollups([mk({ currentPlanSlug: 'alpha', fleetRole: 'member' })]);
    expect(g.warning).toBeNull();
  });

  it('makes the unbound sessions their own filterable group, sorted last', () => {
    const rollups = derivePlanRollups([
      mk({ ownerId: 'su-11111111-a', currentPlanSlug: null }),
      mk({ ownerId: 'su-22222222-b', currentPlanSlug: 'calm' }),
      mk({
        ownerId: 'su-33333333-c',
        currentPlanSlug: 'busy',
        openAwait: { eventKey: 'g', note: null, sinceIso: iso(1000), expiresIso: null },
      }),
    ]);
    expect(rollups.map((r) => r.label)).toEqual(['busy', 'calm', 'no plan']);
    expect(rollups[2].planSlug).toBeNull();
  });
});

describe('buildHudBoard', () => {
  it('filters to su sessions by default so nursery cups cannot rebuild the firehose', () => {
    const board = buildHudBoard(
      [entry({ ownerId: 'su-aaaaaaaa-1' }), entry({ ownerId: 's-1700-cup', agentPaneKind: 'cup' })],
      [],
      { nowMs: NOW },
    );
    expect(board.total).toBe(1);
    expect(board.counts.working).toBe(1);
  });

  it('can opt in to the whole roster', () => {
    const board = buildHudBoard(
      [entry({ ownerId: 'su-aaaaaaaa-1' }), entry({ ownerId: 's-1700-cup', agentPaneKind: 'cup' })],
      [],
      { nowMs: NOW, suOnly: false },
    );
    expect(board.total).toBe(2);
  });

  it('filters by fleet, with null selecting the solo group', () => {
    const roster = [
      entry({ ownerId: 'su-aaaaaaaa-1', fleetSlug: 'atlas' }),
      entry({ ownerId: 'su-bbbbbbbb-2', fleetSlug: null }),
    ];
    expect(buildHudBoard(roster, [], { nowMs: NOW, fleets: ['atlas'] }).total).toBe(1);
    expect(buildHudBoard(roster, [], { nowMs: NOW, fleets: [null] }).total).toBe(1);
    expect(buildHudBoard(roster, [], { nowMs: NOW, fleets: [] }).total).toBe(2);
  });

  it('filters by plan, with null selecting the unbound group', () => {
    const roster = [
      entry({ ownerId: 'su-aaaaaaaa-1', currentPlanSlug: 'alpha' }),
      entry({ ownerId: 'su-bbbbbbbb-2', currentPlanSlug: null }),
    ];
    expect(buildHudBoard(roster, [], { nowMs: NOW, plans: ['alpha'] }).total).toBe(1);
    expect(buildHudBoard(roster, [], { nowMs: NOW, plans: [null] }).total).toBe(1);
    expect(buildHudBoard(roster, [], { nowMs: NOW, plans: [] }).total).toBe(2);
  });

  /* WI-37204 — `exemptOwners`: a session ADDRESSED by its unique id must not be
     filtered off the board by controls the human set while BROWSING. Before
     this, an exact id search could resolve one session and still show an empty
     board (the agent was a non-su cup, or sat in a fleet filtered away an hour
     earlier) — indistinguishable from the search being broken, which is the
     complaint this came from. */
  describe('exemptOwners (WI-37204)', () => {
    const cup = entry({ ownerId: 's-1700-cup', agentPaneKind: 'cup' });
    const other = entry({ ownerId: 'su-cccccccc-3', fleetSlug: 'borealis', currentPlanSlug: 'beta' });

    it('keeps an id-addressed NON-SU session on the board', () => {
      expect(buildHudBoard([cup], [], { nowMs: NOW }).total).toBe(0);
      expect(
        buildHudBoard([cup], [], { nowMs: NOW, exemptOwners: new Set(['s-1700-cup']) }).total,
      ).toBe(1);
    });

    it('keeps an id-addressed session that the fleet filter would drop', () => {
      const opts = { nowMs: NOW, fleets: ['atlas'] };
      expect(buildHudBoard([other], [], opts).total).toBe(0);
      expect(
        buildHudBoard([other], [], { ...opts, exemptOwners: new Set(['su-cccccccc-3']) }).total,
      ).toBe(1);
    });

    it('keeps an id-addressed session that the plan filter would drop', () => {
      const opts = { nowMs: NOW, plans: ['alpha'] };
      expect(buildHudBoard([other], [], opts).total).toBe(0);
      expect(
        buildHudBoard([other], [], { ...opts, exemptOwners: new Set(['su-cccccccc-3']) }).total,
      ).toBe(1);
    });

    it('exempts ONLY the named owners — it is not a filter kill-switch', () => {
      // A text query stays subject to the filters; blowing past su-only for
      // every search would rebuild the ~85-agent firehose the board replaces.
      const board = buildHudBoard(
        [cup, entry({ ownerId: 's-1701-cup2', agentPaneKind: 'cup' })],
        [],
        { nowMs: NOW, exemptOwners: new Set(['s-1700-cup']) },
      );
      expect(board.total).toBe(1);
    });

    it('an empty or absent set changes nothing', () => {
      const roster = [entry({ ownerId: 'su-aaaaaaaa-1' }), cup];
      const base = buildHudBoard(roster, [], { nowMs: NOW }).total;
      expect(buildHudBoard(roster, [], { nowMs: NOW, exemptOwners: new Set() }).total).toBe(base);
      expect(buildHudBoard(roster, [], { nowMs: NOW, exemptOwners: undefined }).total).toBe(base);
    });
  });

  // P-004's "driven by the fleets currently in view", as an assertion: the plan
  // options are derived from the FLEET-filtered set, so selecting a fleet
  // narrows what the plan picker offers.
  it('derives the plan options from the fleet-filtered sessions', () => {
    const roster = [
      entry({ ownerId: 'su-aaaaaaaa-1', fleetSlug: 'atlas', currentPlanSlug: 'alpha' }),
      entry({ ownerId: 'su-bbbbbbbb-2', fleetSlug: 'borealis', currentPlanSlug: 'beta' }),
    ];
    expect(buildHudBoard(roster, [], { nowMs: NOW }).plans.map((p) => p.label))
      .toEqual(['alpha', 'beta']);
    expect(buildHudBoard(roster, [], { nowMs: NOW, fleets: ['atlas'] }).plans.map((p) => p.label))
      .toEqual(['alpha']);
  });

  /* The other half of that ordering, and the one a refactor is most likely to
     break: the options are derived BEFORE the plan filter narrows the board.
     Derive them after and the picker eats its own list — the control collapses
     to the single row already selected and the only way to reach another plan
     is to clear the filter first. */
  it('keeps every in-view plan on offer while one of them is selected', () => {
    const roster = [
      entry({ ownerId: 'su-aaaaaaaa-1', currentPlanSlug: 'alpha' }),
      entry({ ownerId: 'su-bbbbbbbb-2', currentPlanSlug: 'beta' }),
    ];
    const board = buildHudBoard(roster, [], { nowMs: NOW, plans: ['alpha'] });
    expect(board.total).toBe(1);
    expect(board.plans.map((p) => p.label)).toEqual(['alpha', 'beta']);

    // Non-vacuity, by fixture rather than by breaking the source: this is what
    // `plans` WOULD hold if it were derived one line later, from the sessions
    // that survive the filter. The assertion above passes only because the two
    // differ, so a refactor that moves the derivation reds this test.
    const ifDerivedAfterTheFilter = derivePlanRollups(
      board.columns.flatMap((c) => c.sessions),
    ).map((p) => p.label);
    expect(ifDerivedAfterTheFilter).toEqual(['alpha']);
    expect(board.plans.map((p) => p.label)).not.toEqual(ifDerivedAfterTheFilter);
  });

  it('emits every column even when empty, with an all-clear message', () => {
    const board = buildHudBoard([entry()], [], { nowMs: NOW });
    expect(board.columns.map((c) => c.id)).toEqual([
      'needs-you', 'working', 'blocked', 'stalled', 'parked',
    ]);
    expect(board.columns.find((c) => c.id === 'blocked')?.empty).toBe('Nothing is waiting on a gate');
  });

  it('sorts the longest-waiting card to the top of its column', () => {
    const board = buildHudBoard(
      [
        entry({
          ownerId: 'su-aaaaaaaa-1',
          openAwait: { eventKey: 'a', note: null, sinceIso: iso(5 * 60_000), expiresIso: null },
        }),
        entry({
          ownerId: 'su-bbbbbbbb-2',
          openAwait: { eventKey: 'b', note: null, sinceIso: iso(90 * 60_000), expiresIso: null },
        }),
      ],
      [],
      { nowMs: NOW },
    );
    const blocked = board.columns.find((c) => c.id === 'blocked')!;
    expect(blocked.sessions.map((s) => s.handle)).toEqual(['su-bbbbbbbb', 'su-aaaaaaaa']);
  });

  it('routes an ask to its own agent only, leaving peers untouched', () => {
    const board = buildHudBoard(
      [entry({ ownerId: 'su-aaaaaaaa-1' }), entry({ ownerId: 'su-bbbbbbbb-2' })],
      [ask({ ownerAgentId: 'su-aaaaaaaa-1' })],
      { nowMs: NOW },
    );
    expect(board.counts['needs-you']).toBe(1);
    expect(board.columns.find((c) => c.id === 'needs-you')!.sessions[0].ownerId).toBe('su-aaaaaaaa-1');
  });

  it('ignores an ask with no attributable agent rather than mis-assigning it, but surfaces it on board.unattributed', () => {
    const board = buildHudBoard([entry()], [ask({ ownerAgentId: null, id: 'improvement:EI-1', kind: 'improvement' })], {
      nowMs: NOW,
    });
    // Not assigned to any session's needs-you column...
    expect(board.counts['needs-you']).toBe(0);
    // ...but not dropped either — hud-consolidation-2026-07-26 P-002's coverage
    // gate: a needs-human ask with no owning agent must still render SOMEWHERE.
    expect(board.unattributed).toHaveLength(1);
    expect(board.unattributed[0].id).toBe('improvement:EI-1');
  });
});

describe('unattributedAsks (hud-consolidation-2026-07-26 P-002)', () => {
  it('keeps only asks with no ownerAgentId', () => {
    const out = unattributedAsks([
      ask({ id: 'a', ownerAgentId: 'su-aaaaaaaa-1' }),
      ask({ id: 'b', ownerAgentId: null }),
      ask({ id: 'c', ownerAgentId: '' as unknown as null }),
    ]);
    expect(out.map((a) => a.id)).toEqual(['b', 'c']);
  });

  it('sorts oldest first, unknown occurredAt last', () => {
    const out = unattributedAsks([
      ask({ id: 'newer', ownerAgentId: null, occurredAt: iso(5 * 60_000) }),
      ask({ id: 'older', ownerAgentId: null, occurredAt: iso(60 * 60_000) }),
      ask({ id: 'unknown', ownerAgentId: null, occurredAt: null }),
    ]);
    expect(out.map((a) => a.id)).toEqual(['older', 'newer', 'unknown']);
  });

  it('is empty for an all-attributed input, never throwing on an empty array', () => {
    expect(unattributedAsks([])).toEqual([]);
    expect(unattributedAsks([ask({ ownerAgentId: 'su-aaaaaaaa-1' })])).toEqual([]);
  });
});

/* The INSTANT half of the sessions search (owner ask 2026-08-02). The reported
   symptom was "it doesn't automatically run the search, I have to press enter";
   the cause was that the ONLY pass was a 0.4–4.9s round-trip, so typing produced
   no visible change for seconds. This pass runs on the keystroke, over data the
   board already holds, exactly like the Work-items pane's filter. */
describe('matchesSessionText', () => {
  it('matches the fields a human can actually see on the card', () => {
    const e = entry({
      ownerId: 'su-abcd1234-0000-0000-0000-000000000000',
      label: 'su · gym-gate',
      intent: 'Greening the release gate',
      fleetSlug: 'backlog-drain',
      currentPlanSlug: 'hud-search-2026-08-02',
      harnessSlug: 'papercusp',
      role: 'engineer',
    });
    for (const q of [
      'gym', // label
      'greening', // intent
      'backlog', // fleet
      'hud-search', // plan
      'papercusp', // harness
      'engineer', // role
      'abcd1234', // the short handle, which is what the card actually renders
    ]) {
      expect(matchesSessionText(e, q), `expected a hit for ${q}`).toBe(true);
    }
  });

  it('is case-insensitive and substring, like the Work-items pane it mirrors', () => {
    const e = entry({ intent: 'Greening the release gate' });
    expect(matchesSessionText(e, 'RELEASE')).toBe(true);
    expect(matchesSessionText(e, 'eleas')).toBe(true);
  });

  // An empty query means "not filtering", NOT "matches nothing" — getting this
  // backwards blanks the board the moment the box is cleared.
  it('treats an empty or whitespace query as no filter at all', () => {
    const e = entry({ intent: 'anything' });
    expect(matchesSessionText(e, '')).toBe(true);
    expect(matchesSessionText(e, '   ')).toBe(true);
  });

  it('misses when nothing on the card matches, without throwing on null fields', () => {
    const e = entry({
      label: 'su · quiet',
      intent: '',
      fleetSlug: null,
      currentPlanSlug: null,
      harnessSlug: null,
      role: null,
      agent: null,
      fleetRole: null,
    });
    expect(matchesSessionText(e, 'zzzz-no-such-thing')).toBe(false);
  });

  // A one-character query is BELOW the transcript search's 2-char floor, so it
  // is served entirely by this pass — it has to work, or the first keystroke
  // still looks like it did nothing.
  it('filters from the very first character', () => {
    expect(matchesSessionText(entry({ label: 'su · gym' }), 'g')).toBe(true);
    expect(matchesSessionText(entry({ label: 'su · quiet' }), 'z')).toBe(false);
  });

  it('finds a session by a work-item id it has claimed', () => {
    const e = entry({ claims: [{ id: 'WI-7159', planSlug: 'hud-search-2026-08-02' }] });
    expect(matchesSessionText(e, 'WI-7159')).toBe(true);
    expect(matchesSessionText(e, 'wi-7159')).toBe(true);
  });

  /* WI-37204 (owner ask 2026-08-08 — "search by the su id and the session id").
     The su id already worked via `ownerId`; the NATIVE session id matched
     nothing, because the roster payload carried it but `HudRosterEntry` never
     typed it. These are the two handles a human actually holds for a session
     when it comes out of a log, a `--resume` line, or a work-item body. */
  it('finds a session by its native claude session id', () => {
    const e = entry({
      ownerId: 'su-abcd1234-0000-0000-0000-000000000000',
      sessionId: '073c5a1e-d280-4c37-866c-fedcaf096c9e',
    });
    expect(matchesSessionText(e, '073c5a1e-d280-4c37-866c-fedcaf096c9e')).toBe(true);
    // The 8-hex head, which is the form a truncated card renders.
    expect(matchesSessionText(e, '073c5a1e')).toBe(true);
    expect(matchesSessionText(e, '073C5A1E')).toBe(true);
  });

  it('finds an omp session by its thread id', () => {
    const e = entry({ ompThreadId: 'ef982cad-72df-4e56-b75a-07c30ed03518' });
    expect(matchesSessionText(e, 'ef982cad')).toBe(true);
  });

  it('still finds a session by its full su id and short handle', () => {
    const e = entry({ ownerId: 'su-bc38a419-8dc6-4040-a63e-2dc0515e42be' });
    expect(matchesSessionText(e, 'su-bc38a419-8dc6-4040-a63e-2dc0515e42be')).toBe(true);
    expect(matchesSessionText(e, 'su-bc38a419')).toBe(true);
  });

  it('does not throw when an entry carries neither id (a pending/starting launch)', () => {
    const e = entry({ sessionId: null, ompThreadId: null });
    expect(matchesSessionText(e, '073c5a1e')).toBe(false);
  });
});

/* The excerpt shown on a matched card (owner ask 2026-08-02). The safety
   property is the point of these: every run becomes a TEXT node, so transcript
   content can never be rendered as markup no matter what the server sent. */
describe('parseHighlight', () => {
  it('splits ts_headline output into marked and unmarked runs', () => {
    const segs = parseHighlight('the <mark>Harrier</mark> embedder');
    expect(segs.map((s) => [s.text, s.mark])).toEqual([
      ['the ', false],
      ['Harrier', true],
      [' embedder', false],
    ]);
  });

  it('handles several marks, and a string that is entirely one mark', () => {
    expect(parseHighlight('<mark>a</mark> b <mark>c</mark>').filter((s) => s.mark).map((s) => s.text))
      .toEqual(['a', 'c']);
    expect(parseHighlight('<mark>only</mark>')).toEqual([{ text: 'only', mark: true }]);
  });

  // THE security property. Transcript text routinely contains markup and quoted
  // HTML; a <script> in an excerpt must arrive as characters to render, never as
  // a tag. Segments make that structural rather than dependent on the server's
  // escaper staying correct forever.
  it('never yields markup — a script tag in the excerpt stays literal text', () => {
    const segs = parseHighlight('before <script>alert(1)</script> after');
    const joined = segs.map((s) => s.text).join('');
    expect(joined).toContain('<script>alert(1)</script>');
    expect(segs.every((s) => !s.mark)).toBe(true);
  });

  it('decodes the entities ts_headline escapes, including numeric ones', () => {
    const segs = parseHighlight('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;');
    expect(segs.map((s) => s.text).join('')).toBe(`a & b <c> "d" 'e' A`);
  });

  // Excerpts carry markdown and hard newlines; left alone they shred a clamped
  // card into ragged fragments. This is a DISPLAY helper, so it condenses.
  it('condenses newlines and runs of whitespace', () => {
    const segs = parseHighlight('one\n\n##   two\t\tthree');
    expect(segs.map((s) => s.text).join('')).toBe('one ## two three');
  });

  it('drops empty runs rather than emitting blank segments', () => {
    expect(parseHighlight('<mark>x</mark>')).toHaveLength(1);
    expect(parseHighlight('')).toEqual([]);
    expect(parseHighlight('   ')).toEqual([]);
  });

  it('leaves an unterminated mark as literal text rather than swallowing the rest', () => {
    const segs = parseHighlight('start <mark>never closed');
    expect(segs.map((s) => s.text).join('')).toBe('start <mark>never closed');
    expect(segs.every((s) => !s.mark)).toBe(true);
  });
});

describe('searchHitAnchor', () => {
  const hit = (over: Partial<HudSearchHit> = {}): HudSearchHit => ({
    turnIdx: 3,
    highlight: null,
    excerpt: '',
    speaker: 'assistant',
    ts: null,
    sessionId: 's1',
    sourceKind: 'claude',
    more: 0,
    ...over,
  });

  it('strips the <mark> tags — the anchor must be text the transcript literally contains', () => {
    expect(
      searchHitAnchor(hit({ highlight: 'the <mark>Harrier</mark> embedder never converged' })),
    ).toBe('the Harrier embedder never converged');
  });

  it('takes the LONGEST fragment: ts_headline glues up to 2 with " … ", so the whole string is not contiguous', () => {
    // A substring search for the joined string would find nothing at all —
    // the ellipsis stands for text that was cut out between the fragments.
    expect(
      searchHitAnchor(
        hit({ highlight: 'a short <mark>bit</mark> … the considerably longer second fragment here' }),
      ),
    ).toBe('the considerably longer second fragment here');
  });

  it('decodes entities — ts_headline escapes, the transcript holds the raw character', () => {
    expect(searchHitAnchor(hit({ highlight: 'if a &lt; b &amp;&amp; c &gt; d then bail' }))).toBe(
      'if a < b && c > d then bail',
    );
  });

  it('condenses whitespace, because ts_headline reflows the source newlines away', () => {
    expect(searchHitAnchor(hit({ highlight: 'line one\n\n   line two continues' }))).toBe(
      'line one line two continues',
    );
  });

  it('falls back to the excerpt MINUS its synthetic [speaker owner ts] prefix', () => {
    // That prefix is built by the search source and appears nowhere in the
    // transcript, so leaving it on guarantees the anchor never matches.
    expect(
      searchHitAnchor(
        hit({ excerpt: '[assistant su-ae348 2026-08-02T10:00:00Z] the deploy wedged on a lock timeout' }),
      ),
    ).toBe('the deploy wedged on a lock timeout');
  });

  it('prefers the highlight over the excerpt — a headline fragment sits ON the match', () => {
    expect(
      searchHitAnchor(
        hit({
          highlight: 'wedged on a <mark>lock</mark> timeout',
          excerpt: '[assistant] some earlier prefix of the same turn entirely',
        }),
      ),
    ).toBe('wedged on a lock timeout');
  });

  it('declines an anchor too short to discriminate rather than returning a bad one', () => {
    // 'a b' would match half the transcript, and the FIRST such match is
    // almost never the hit — a wrong scroll is worse than no scroll.
    expect(searchHitAnchor(hit({ highlight: '<mark>a</mark> b' }))).toBeNull();
    expect(searchHitAnchor(hit({ highlight: '', excerpt: '[user] hi' }))).toBeNull();
  });

  it('returns null for no hit at all (the card was not a search result)', () => {
    expect(searchHitAnchor(null)).toBeNull();
    expect(searchHitAnchor(undefined)).toBeNull();
  });

  it('drops a trailing … so the anchor is not searched for with the truncation marker', () => {
    const a = searchHitAnchor(hit({ excerpt: '[user] the first two hundred characters of the turn…' }));
    expect(a).toBe('the first two hundred characters of the turn');
  });
});

/**
 * WI-7344 — the transcript-search round-trip.
 *
 * Owner report 2026-08-03: "searched 'theory' … still showed searching
 * transcripts 30 seconds later". The call had no deadline, so a stalled
 * operator spun forever with no error. These cover the deadline AND the
 * discrimination that makes it work: a timeout and a supersede/unmount abort
 * both set `signal.aborted`, so a caller branching on that flag alone swallows
 * the timeout and re-creates the hang the deadline was added to prevent.
 */
describe('fetchTranscriptSearch', () => {
  const session = (over: Record<string, unknown> = {}) => ({
    active: { ownerId: 'su-aaa' },
    sessionId: 's1',
    sourceKind: 'claude',
    hits: [
      { turnIdx: 7, excerpt: 'a theory of gates', highlight: 'a <mark>theory</mark> of gates' },
    ],
    ...over,
  });
  const okResponse = (sessions: unknown[]) =>
    ({ ok: true, json: async () => ({ ok: true, sessions }) }) as unknown as Response;
  /** A fetch that never settles on its own — the wedged-operator case. */
  const neverSettles = ((_u: string, init?: { signal?: AbortSignal }) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () =>
        rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
    })) as unknown as typeof fetch;

  it('returns owners + best hit on a normal response', async () => {
    const r = await fetchTranscriptSearch('theory', {
      timeoutMs: 1000,
      fetchImpl: (async () => okResponse([session()])) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.owners]).toEqual(['su-aaa']);
    expect(r.hits.get('su-aaa')?.turnIdx).toBe(7);
    expect(r.hits.get('su-aaa')?.more).toBe(0);
  });

  /* WI-37912 — the client half of the owner-visibility disclosure. The route
     emits `hiddenMachineHits` on every 200; nothing parsed it, so a page that
     came back 2/3 filtered was indistinguishable from a page with few matches. */
  it('carries the owner-visibility hidden count through to the caller', async () => {
    const r = await fetchTranscriptSearch('loop wake', {
      timeoutMs: 1000,
      fetchImpl: (async () =>
        ({
          ok: true,
          json: async () => ({
            ok: true,
            sessions: [session()],
            hiddenMachineHits: { count: 74, truncatedByLimit: true },
          }),
        }) as unknown as Response) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hiddenMachineHits).toEqual({ count: 74, truncatedByLimit: true });
  });

  /* An OLDER server predating the field must degrade to "nothing hidden" — a
     missing disclosure, never a fabricated count on a page that was never
     filtered. Same for a malformed/negative body: it is not evidence. */
  it('degrades a missing or malformed hidden count to zero rather than guessing', async () => {
    for (const bad of [undefined, null, {}, { count: -3 }, { count: 'lots' }]) {
      const r = await fetchTranscriptSearch('theory', {
        timeoutMs: 1000,
        fetchImpl: (async () =>
          ({
            ok: true,
            json: async () => ({ ok: true, sessions: [session()], hiddenMachineHits: bad }),
          }) as unknown as Response) as unknown as typeof fetch,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.hiddenMachineHits).toEqual({ count: 0, truncatedByLimit: false });
    }
  });

  it('reports a TIMEOUT as an outcome, not a hang — the whole point of WI-7344', async () => {
    // Before the fix this awaited forever and the "searching transcripts…"
    // chip never cleared.
    const r = await fetchTranscriptSearch('theory', {
      timeoutMs: 10,
      fetchImpl: neverSettles,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.timedOut).toBe(true);
    expect(r.message).toMatch(/timed out/i);
  });

  it('does NOT report a caller abort as a timeout — it rethrows for the caller to ignore', async () => {
    // The discrimination that keeps the deadline honest. If a supersede abort
    // came back as `timedOut`, every keystroke would flash a spurious
    // "timed out" error at the owner.
    const outer = new AbortController();
    const p = fetchTranscriptSearch('theory', {
      timeoutMs: 60_000,
      signal: outer.signal,
      fetchImpl: neverSettles,
    });
    outer.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });

  it('surfaces a server-side failure as a non-timeout error', async () => {
    const r = await fetchTranscriptSearch('theory', {
      timeoutMs: 1000,
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({ ok: false, error: 'boom' }),
        }) as unknown as Response) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.timedOut).toBe(false);
    expect(r.message).toBe('boom');
  });
});

describe('rollUpTranscriptSearch', () => {
  it('counts an owner as matched even when its top hit has no renderable text', () => {
    // The session genuinely matched; only the excerpt strip is unrenderable.
    // Dropping the OWNER too would silently hide a real result from the board.
    const { owners, hits } = rollUpTranscriptSearch([
      { active: { ownerId: 'su-a' }, hits: [{ excerpt: '   ', highlight: null }] },
    ]);
    expect([...owners]).toEqual(['su-a']);
    expect(hits.has('su-a')).toBe(false);
  });

  it('falls back to the inactive session owner id, and reports the other-match count', () => {
    const { owners, hits } = rollUpTranscriptSearch([
      {
        active: null,
        session: { coordOwnerId: 'su-b' },
        sessionId: 's9',
        hits: [{ excerpt: 'first' }, { excerpt: 'second' }, { excerpt: 'third' }],
      },
    ]);
    expect([...owners]).toEqual(['su-b']);
    expect(hits.get('su-b')?.more).toBe(2);
    expect(hits.get('su-b')?.turnIdx).toBe(-1); // absent turnIdx must not become 0
  });

  it('skips a session with no attributable owner instead of keying on empty string', () => {
    const { owners, hits } = rollUpTranscriptSearch([
      { active: null, session: null, hits: [{ excerpt: 'x' }] },
    ]);
    expect(owners.size).toBe(0);
    expect(hits.size).toBe(0);
  });

  it('treats a null/absent session list as no matches', () => {
    expect(rollUpTranscriptSearch(null).owners.size).toBe(0);
    expect(rollUpTranscriptSearch(undefined).hits.size).toBe(0);
  });

  it('carries the top hit\'s focusTerm (P-004 exact/fuzzy tiers) so the open anchors on the literal the turn contains; absent stays absent', () => {
    const { hits } = rollUpTranscriptSearch([
      {
        active: { ownerId: 'su-ff' },
        sessionId: 's1',
        hits: [{ excerpt: 'visit www.furnishedfinder.com', highlight: '<mark>furnishedfinder</mark>', focusTerm: 'furnishedfinder' }],
      },
      { active: { ownerId: 'su-plain' }, sessionId: 's2', hits: [{ excerpt: 'plain hybrid hit', focusTerm: null }] },
    ]);
    expect(hits.get('su-ff')?.focusTerm).toBe('furnishedfinder');
    // null/missing focusTerm must NOT become an empty-string claim (the open then uses the typed query).
    expect('focusTerm' in hits.get('su-plain')!).toBe(false);
  });
});
