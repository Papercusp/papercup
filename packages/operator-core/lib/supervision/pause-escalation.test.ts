/**
 * EI-20003974512096022 fixes 1+2 — a persistent administrative pause escalates into ONE durable,
 * claimable EI, and its broadcast salience ramps with the pause's age.
 *
 * The incident: `papercup-live-federation-gate.timer` — a release-blocker gate — sat
 * administratively disabled for 2 days. The reconciler detected it correctly every time and
 * emitted 16 identical `⏸ … respecting the pause` broadcasts. Not one produced an action, because
 * a broadcast has no owner and appears in no backlog.
 *
 * The tests that matter here are the DURABILITY pair (`survives a process restart` + its
 * `AMNESIAC CONTROL`): the threshold is only meaningful if its clock outlives the process, and a
 * suite that never simulates a restart would pass identically against the in-memory clock this
 * replaces.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  decidePause,
  pauseTierFor,
  formatPauseDuration,
  PAUSE_ESCALATION_MS,
  PAUSE_SALIENCE_TIERS,
  _resetPauseClockForTests,
  type PauseState,
  type PauseStoreDeps,
} from './pause-clock';
import { reconcileTick, _resetReconcilerState, type ReconcilerDeps } from './unit-reconciler';
import { supervisionPausedEiTitle } from './paused-unit-ei';
import type { SupervisionEntry } from '../service-health';

const HOUR = 60 * 60 * 1000;

/** The real unit from the incident: `disable --now` drops it out of `list-units --all` entirely,
 *  while `systemctl show` still resolves it as loaded-but-disabled. */
const TIMER_ENTRY: SupervisionEntry = {
  name: 'live-federation-gate-timer',
  layer: 'systemd-user',
  unit: 'papercup-live-federation-gate.timer',
  criticality: 'important',
  autoRestart: true,
};

/** A DURABLE store stand-in: survives across `reconcileTick` calls, exactly as migration 812's
 *  row does across process restarts. */
function durableStore(seed: PauseState = {}): PauseStoreDeps & { state: PauseState } {
  const box = {
    state: seed,
    async update(mutate: (current: PauseState) => PauseState) {
      box.state = mutate(box.state);
      return box.state;
    },
  };
  return box;
}

/**
 * The PRE-812 behaviour, as a control: an in-memory clock that a process restart wipes. Every
 * tick sees an empty baseline, so `pausedSince` is re-seeded to "now" forever.
 */
function amnesiacStore(): PauseStoreDeps {
  return {
    async update(mutate: (current: PauseState) => PauseState) {
      return mutate({});
    },
  };
}

function makeDeps(overrides: Partial<ReconcilerDeps> = {}): ReconcilerDeps & {
  notify: ReturnType<typeof vi.fn>;
  filePausedEi: ReturnType<typeof vi.fn>;
  resolvePausedEi: ReturnType<typeof vi.fn>;
} {
  return {
    execUser: vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units') return ''; // the timer is absent from the listing, as when disabled
      if (args[0] === 'show') return 'Result=success\nNRestarts=0\nUnitFileState=disabled\nLoadState=loaded\n';
      return '';
    }),
    now: () => 1_000_000,
    notify: vi.fn(async () => {}),
    autoRestartFlagOn: async () => true,
    registry: () => [TIMER_ENTRY],
    filePausedEi: vi.fn(async () => 'EI-fake'),
    resolvePausedEi: vi.fn(async () => ['EI-fake']),
    ...overrides,
  } as ReconcilerDeps & {
    notify: ReturnType<typeof vi.fn>;
    filePausedEi: ReturnType<typeof vi.fn>;
    resolvePausedEi: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  _resetReconcilerState();
  _resetPauseClockForTests();
});

describe('pause clock — pure ramp/threshold logic', () => {
  it('picks the HIGHEST tier reached, not the first matching one', () => {
    expect(pauseTierFor(0).id).toBe('observed');
    expect(pauseTierFor(59 * 60 * 1000).id).toBe('observed');
    expect(pauseTierFor(HOUR).id).toBe('1h');
    expect(pauseTierFor(4 * HOUR).id).toBe('4h');
    expect(pauseTierFor(30 * HOUR).id).toBe('24h');
    expect(pauseTierFor(365 * 24 * HOUR).id).toBe('72h');
  });

  it('escalation tiers route to the ESCALATION channel, ambient ones do not (fix 2)', () => {
    // The whole point of the ramp: a 48h dark release-blocker must not arrive at the same
    // level as an 8-minute one.
    expect(pauseTierFor(10 * 60 * 1000).kind).toBe('message');
    expect(pauseTierFor(4 * HOUR).kind).toBe('escalation');
    expect(pauseTierFor(48 * HOUR).kind).toBe('escalation');
  });

  it('seeds pausedSince on first observation and PRESERVES it across ticks', () => {
    const t0 = 1_000_000;
    const first = decidePause(undefined, t0);
    expect(first.decision.pausedSince).toBe(t0);
    expect(first.decision.durationMs).toBe(0);

    const later = decidePause(first.next, t0 + 3 * HOUR);
    expect(later.decision.pausedSince).toBe(t0); // NOT re-seeded
    expect(later.decision.durationMs).toBe(3 * HOUR);
  });

  it('escalates only past the threshold, and only ONCE (fix 1 idempotence)', () => {
    const t0 = 1_000_000;
    let rec = decidePause(undefined, t0).next;

    const justUnder = decidePause(rec, t0 + PAUSE_ESCALATION_MS - 1);
    expect(justUnder.decision.shouldEscalate).toBe(false);
    rec = justUnder.next;

    const at = decidePause(rec, t0 + PAUSE_ESCALATION_MS);
    expect(at.decision.shouldEscalate).toBe(true);
    rec = at.next;

    // Every subsequent tick of the SAME standing pause must not re-file.
    for (const dt of [PAUSE_ESCALATION_MS + 1, 12 * HOUR, 48 * HOUR]) {
      const again = decidePause(rec, t0 + dt);
      expect(again.decision.shouldEscalate).toBe(false);
      rec = again.next;
    }
  });

  it('notifies once per TIER, not once per tick — the 16-broadcasts defect', () => {
    const t0 = 1_000_000;
    let rec = decidePause(undefined, t0).next;
    let notifications = 1; // the initial 'observed'

    // 48 hours of ticks, one per minute.
    for (let m = 1; m <= 48 * 60; m++) {
      const r = decidePause(rec, t0 + m * 60_000);
      if (r.decision.notify) notifications++;
      rec = r.next;
    }

    // Four tiers are reachable inside 48h: observed, 1h, 4h, 24h. Not 2,880.
    expect(notifications).toBe(4);
  });

  it('formats durations coarsely', () => {
    expect(formatPauseDuration(5 * 60_000)).toBe('5m');
    expect(formatPauseDuration(3 * HOUR)).toBe('3h');
    expect(formatPauseDuration(50 * HOUR)).toBe('2d');
  });

  it('tiers are ordered ascending — pauseTierFor depends on it', () => {
    const afters = PAUSE_SALIENCE_TIERS.map((t) => t.afterMs);
    expect([...afters].sort((a, b) => a - b)).toEqual(afters);
  });
});

describe('EI-20003974512096022 fix 1 — a persistent pause becomes a claimable EI', () => {
  it('files NOTHING while the pause is young', async () => {
    const store = durableStore();
    const deps = makeDeps({ pauseStore: store });
    await reconcileTick(deps);
    expect(deps.filePausedEi).not.toHaveBeenCalled();
    // ...but it does still broadcast the ambient FYI, exactly as before.
    const summaries = deps.notify.mock.calls.map((c) => c[0].summary as string);
    expect(summaries.some((s) => s.includes('administratively disabled/masked'))).toBe(true);
  });

  it('files ONE EI once the pause outlives the threshold, and never a second (16 → 1)', async () => {
    const store = durableStore();
    let now = 1_000_000;
    const deps = makeDeps({ pauseStore: store, now: () => now });

    // 48 hours of ticks at the real 60s cadence.
    for (let i = 0; i <= 48 * 60; i++) {
      await reconcileTick(deps);
      now += 60_000;
    }

    expect(deps.filePausedEi).toHaveBeenCalledTimes(1);
    const episode = deps.filePausedEi.mock.calls[0][0];
    expect(episode.unit).toBe('papercup-live-federation-gate.timer');
    expect(episode.pausedForMs).toBeGreaterThanOrEqual(PAUSE_ESCALATION_MS);
  });

  it('SURVIVES A PROCESS RESTART — the durable clock is what makes the threshold reachable', async () => {
    // The reconciler's in-memory state is wiped between these ticks (a bg-host restart), but the
    // durable store is not. This is the case the whole migration exists for.
    const store = durableStore();
    let now = 1_000_000;

    for (const hoursIn of [0, 1, 2, 3, 5]) {
      _resetReconcilerState(); // simulate a fresh process each time
      now = 1_000_000 + hoursIn * HOUR;
      const deps = makeDeps({ pauseStore: store, now: () => now });
      await reconcileTick(deps);
      if (hoursIn === 5) {
        expect(deps.filePausedEi).toHaveBeenCalledTimes(1);
        expect(deps.filePausedEi.mock.calls[0][0].pausedForMs).toBe(5 * HOUR);
      } else {
        expect(deps.filePausedEi).not.toHaveBeenCalled();
      }
    }
  });

  it('AMNESIAC CONTROL: with the pre-812 in-memory clock, that same 5h pause NEVER escalates', async () => {
    // Calibration. If this control also escalated, the test above would prove nothing about
    // durability — it would pass against the very in-memory clock this replaces.
    let now = 1_000_000;
    const filed: unknown[] = [];

    for (const hoursIn of [0, 1, 2, 3, 5, 24, 48]) {
      _resetReconcilerState();
      now = 1_000_000 + hoursIn * HOUR;
      const deps = makeDeps({
        pauseStore: amnesiacStore(),
        now: () => now,
        filePausedEi: vi.fn(async (e: unknown) => {
          filed.push(e);
          return 'EI-fake';
        }),
      });
      await reconcileTick(deps);
    }

    expect(filed).toHaveLength(0);
  });

  it('resolves the EI once the unit is observed no longer paused', async () => {
    const store = durableStore();
    let now = 1_000_000;
    const paused = makeDeps({ pauseStore: store, now: () => now });
    await reconcileTick(paused);
    expect(store.state['papercup-live-federation-gate.timer']).toBeDefined();

    now += HOUR;
    const resumed = makeDeps({
      pauseStore: store,
      now: () => now,
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return 'papercup-live-federation-gate.timer loaded active waiting Timer\n';
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\nUnitFileState=enabled\nLoadState=loaded\n';
        return '';
      }),
    });
    await reconcileTick(resumed);

    expect(resumed.resolvePausedEi).toHaveBeenCalledWith({ unit: 'papercup-live-federation-gate.timer' });
    // The clock is cleared, so a LATER pause starts a fresh episode rather than inheriting this age.
    expect(store.state['papercup-live-federation-gate.timer']).toBeUndefined();
  });

  it('an UNREADABLE show-probe does not clear the clock or resolve the EI (fail-safe direction)', async () => {
    // "We could not tell" must never be mistaken for "the pause ended" — that would restart the
    // clock on a read error and re-arm the never-fires bug.
    const store = durableStore();
    let now = 1_000_000;
    await reconcileTick(makeDeps({ pauseStore: store, now: () => now }));
    const seeded = store.state['papercup-live-federation-gate.timer'];
    expect(seeded).toBeDefined();

    now += 2 * HOUR;
    const blind = makeDeps({
      pauseStore: store,
      now: () => now,
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return '';
        throw new Error('systemctl show failed');
      }),
    });
    await reconcileTick(blind);

    expect(blind.resolvePausedEi).not.toHaveBeenCalled();
    expect(store.state['papercup-live-federation-gate.timer']?.pausedSince).toBe(seeded.pausedSince);
  });
});

describe('EI-20003974512096022 fix 2 — salience ramps with duration', () => {
  it('past the 4h tier the broadcast routes to the ESCALATION channel, not ambient supervision', async () => {
    const store = durableStore();
    let now = 1_000_000;
    await reconcileTick(makeDeps({ pauseStore: store, now: () => now }));

    now += 5 * HOUR;
    const aged = makeDeps({ pauseStore: store, now: () => now });
    await reconcileTick(aged);

    const escalations = aged.notify.mock.calls.filter((c) => c[0].kind === 'escalation');
    expect(escalations).toHaveLength(1);
    expect(escalations[0][0].summary).toContain('over 4 hours');
    expect(escalations[0][0].summary).toContain('dark');
  });

  it('a standing pause does NOT re-broadcast on every tick within one tier', async () => {
    const store = durableStore();
    let now = 1_000_000;
    const deps = makeDeps({ pauseStore: store, now: () => now });
    for (let i = 0; i < 30; i++) {
      await reconcileTick(deps);
      now += 60_000; // 30 minutes, all inside the 'observed' tier
    }
    const pauseNotifies = deps.notify.mock.calls.filter((c) =>
      (c[0].summary as string).includes('disabled/masked'),
    );
    expect(pauseNotifies).toHaveLength(1);
  });
});

describe('paused-unit EI identity', () => {
  it('the dedup title is keyed on the UNIT only, so an ageing pause stays ONE row', () => {
    const a = supervisionPausedEiTitle({ unit: 'papercup-live-federation-gate.timer' });
    const b = supervisionPausedEiTitle({ unit: 'papercup-live-federation-gate.timer' });
    expect(a).toBe(b);
    expect(a).toContain('papercup-live-federation-gate.timer');
    expect(a).toContain('[supervision-paused]');
  });
});
