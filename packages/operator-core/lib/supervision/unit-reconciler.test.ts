/**
 * unit-reconciler — failed-unit reconciler pure functions + orchestrator
 * (critical-process-supervisor-2026-07-04 P-002).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseSystemctlListUnits,
  parseSystemctlShowProperties,
  isUnitDown,
  decideReconcile,
  initialFlapState,
  reconcileTick,
  _resetReconcilerState,
  checkRestartPolicyDrift,
  BACKOFF_SEQUENCE_SEC,
  GIVE_UP_THRESHOLD,
  GIVE_UP_WINDOW_MS,
  HEALTHY_RESET_MS,
  type SystemctlUnitStatus,
  type ReconcilerDeps,
} from './unit-reconciler';
import type { SupervisionEntry } from '../service-health';

const AUTORESTART_ENTRY: SupervisionEntry = {
  name: 'mcp-proxy',
  layer: 'systemd-user',
  unit: 'papercup-mcp-proxy',
  criticality: 'important',
  autoRestart: true,
};

const REPORT_ONLY_ENTRY: SupervisionEntry = {
  name: 'live-federation-gate',
  layer: 'systemd-user',
  unit: 'papercup-live-federation-gate',
  criticality: 'important',
  autoRestart: false,
};

const LIST_UNITS_FIXTURE = [
  'papercup-bg-host.service                         loaded active   running Papercusp dedicated background host',
  'papercup-live-federation-gate.service            loaded inactive dead    Live 2-peer federation gate',
  'papercup-mcp-proxy.service                       loaded failed   failed  Papercusp resilient MCP proxy',
  '',
].join('\n');

describe('parseSystemctlListUnits', () => {
  it('parses unit/load/active/sub/description columns', () => {
    const rows = parseSystemctlListUnits(LIST_UNITS_FIXTURE);
    expect(rows).toEqual([
      { unit: 'papercup-bg-host.service', load: 'loaded', active: 'active', sub: 'running', description: 'Papercusp dedicated background host' },
      { unit: 'papercup-live-federation-gate.service', load: 'loaded', active: 'inactive', sub: 'dead', description: 'Live 2-peer federation gate' },
      { unit: 'papercup-mcp-proxy.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'Papercusp resilient MCP proxy' },
    ]);
  });

  it('tolerates a leading "●" bullet marker and blank lines', () => {
    const rows = parseSystemctlListUnits('\n● foo.service loaded failed failed some desc\n\n');
    expect(rows).toEqual([{ unit: 'foo.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'some desc' }]);
  });

  it('returns [] for empty output', () => {
    expect(parseSystemctlListUnits('')).toEqual([]);
    expect(parseSystemctlListUnits('   \n  \n')).toEqual([]);
  });
});

describe('parseSystemctlShowProperties', () => {
  it('parses Key=Value lines', () => {
    expect(parseSystemctlShowProperties('Restart=always\nResult=success\nNRestarts=0\n')).toEqual({
      Restart: 'always',
      Result: 'success',
      NRestarts: '0',
    });
  });

  it('handles a value containing "="', () => {
    expect(parseSystemctlShowProperties('ExecStart={ path=/bin/x ; argv[]=x }')).toEqual({
      ExecStart: '{ path=/bin/x ; argv[]=x }',
    });
  });
});

describe('isUnitDown', () => {
  const s = (active: string): SystemctlUnitStatus => ({ unit: 'x.service', load: 'loaded', active, sub: 'n/a', description: '' });
  it('active/activating/reloading/deactivating are NOT down', () => {
    for (const a of ['active', 'activating', 'reloading', 'deactivating']) expect(isUnitDown(s(a))).toBe(false);
  });
  it('failed/inactive ARE down', () => {
    expect(isUnitDown(s('failed'))).toBe(true);
    expect(isUnitDown(s('inactive'))).toBe(true);
  });
  it('an undefined status (unit not reported at all) is down', () => {
    expect(isUnitDown(undefined)).toBe(true);
  });
});

describe('decideReconcile', () => {
  const down = (unit: string): SystemctlUnitStatus => ({ unit, load: 'loaded', active: 'failed', sub: 'failed', description: '' });
  const up = (unit: string): SystemctlUnitStatus => ({ unit, load: 'loaded', active: 'active', sub: 'running', description: '' });

  it('healthy unit -> action "healthy", no state change of note', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: up('papercup-mcp-proxy.service'),
      show: undefined,
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'healthy', unit: 'mcp-proxy' });
  });

  it('down + autoRestart flag OFF -> report-only, notify on the FIRST tick of the down streak', () => {
    const state = initialFlapState('papercup-mcp-proxy.service');
    const r1 = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: undefined, state, autoRestartFlagOn: false, now: 1000 });
    expect(r1.action).toEqual({ kind: 'report-only', unit: 'mcp-proxy', reason: 'down-report-only', notify: true });
    const r2 = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: undefined, state: r1.nextState, autoRestartFlagOn: false, now: 2000 });
    expect(r2.action).toEqual({ kind: 'report-only', unit: 'mcp-proxy', reason: 'down-report-only', notify: false });
  });

  it('down + entry.autoRestart:false (e.g. the federation gate) -> report-only regardless of the flag', () => {
    const { action } = decideReconcile({
      entry: REPORT_ONLY_ENTRY,
      status: down('papercup-live-federation-gate.service'),
      show: undefined,
      state: initialFlapState('papercup-live-federation-gate.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'report-only', unit: 'live-federation-gate', reason: 'down-report-only', notify: true });
  });

  it('unit not found by systemctl at all -> report-only "unit-not-found"', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: undefined,
      show: undefined,
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'report-only', unit: 'mcp-proxy', reason: 'unit-not-found', notify: true });
  });

  it('down + flag on + autoRestart:true -> restart with the FIRST backoff rung', () => {
    const { action, nextState } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'success' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'restart', unit: 'mcp-proxy', backoffSec: BACKOFF_SEQUENCE_SEC[0] });
    expect(nextState.restarts).toEqual([1000]);
    expect(nextState.backoffIndex).toBe(1);
    expect(nextState.lastRestartAt).toBe(1000);
  });

  it('a second restart attempt too soon (before the backoff wait elapses) -> waiting-backoff, no double-restart', () => {
    const first = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'success' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 0,
    });
    // BACKOFF_SEQUENCE_SEC[0] = 1s; try again 500ms later — too soon.
    const second = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'success' },
      state: first.nextState,
      autoRestartFlagOn: true,
      now: 500,
    });
    expect(second.action).toEqual({ kind: 'waiting-backoff', unit: 'mcp-proxy' });
  });

  it('after the backoff wait elapses, a second restart attempt fires (backoff rung advances)', () => {
    const first = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'success' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 0,
    });
    const second = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'success' },
      state: first.nextState,
      autoRestartFlagOn: true,
      now: BACKOFF_SEQUENCE_SEC[0] * 1000 + 1,
    });
    expect(second.action).toEqual({ kind: 'restart', unit: 'mcp-proxy', backoffSec: BACKOFF_SEQUENCE_SEC[1] });
  });

  it('systemd start-limit-hit -> escalate-start-limit-hit, latches gaveUp (no further restart attempts)', () => {
    const { action, nextState } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'start-limit-hit' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'escalate-start-limit-hit', unit: 'mcp-proxy' });
    expect(nextState.gaveUp).toBe(true);

    const next = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'start-limit-hit' },
      state: nextState,
      autoRestartFlagOn: true,
      now: 2000,
    });
    expect(next.action).toEqual({ kind: 'already-escalated', unit: 'mcp-proxy' });
  });

  it('the first GIVE_UP_THRESHOLD restarts within the window are allowed; the NEXT attempt gives up instead of restarting again', () => {
    let state = initialFlapState('papercup-mcp-proxy.service');
    let now = 0;
    // Drive GIVE_UP_THRESHOLD (6) successful restart attempts, each spaced past its own backoff wait.
    for (let i = 0; i < GIVE_UP_THRESHOLD; i++) {
      const r = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: { result: 'success' }, state, autoRestartFlagOn: true, now });
      expect(r.action.kind).toBe('restart');
      state = r.nextState;
      now += 61_000; // past even the 60s cap rung
    }
    expect(state.restarts.length).toBe(GIVE_UP_THRESHOLD);
    // The (GIVE_UP_THRESHOLD + 1)th attempt (still inside the 10-minute window) gives up instead
    // of restarting further — a crash-loop is a code fault, not something to restart forever.
    const next = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: { result: 'success' }, state, autoRestartFlagOn: true, now });
    expect(next.action).toEqual({ kind: 'escalate-give-up', unit: 'mcp-proxy', restartsInWindow: GIVE_UP_THRESHOLD });
    expect(next.nextState.gaveUp).toBe(true);
  });

  it('restarts older than the 10-minute window are pruned before counting toward give-up', () => {
    const oldRestarts = [0, 1000, 2000, 3000, 4000]; // all > 10min before `now`
    const state = { ...initialFlapState('papercup-mcp-proxy.service'), restarts: oldRestarts, backoffIndex: 3, lastRestartAt: 4000 };
    const now = GIVE_UP_WINDOW_MS + 5000;
    const { action } = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: { result: 'success' }, state, autoRestartFlagOn: true, now });
    expect(action.kind).toBe('restart'); // not give-up — the old restarts fell out of the window
  });

  it('recovery: down -> healthy transition fires "recovered" once, then plain "healthy"', () => {
    const downState = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: { result: 'success' }, state: initialFlapState('papercup-mcp-proxy.service'), autoRestartFlagOn: true, now: 0 }).nextState;
    const r1 = decideReconcile({ entry: AUTORESTART_ENTRY, status: up('papercup-mcp-proxy.service'), show: undefined, state: downState, autoRestartFlagOn: true, now: 5000 });
    expect(r1.action).toEqual({ kind: 'recovered', unit: 'mcp-proxy' });
    const r2 = decideReconcile({ entry: AUTORESTART_ENTRY, status: up('papercup-mcp-proxy.service'), show: undefined, state: r1.nextState, autoRestartFlagOn: true, now: 6000 });
    expect(r2.action).toEqual({ kind: 'healthy', unit: 'mcp-proxy' });
  });

  it('5 minutes continuously healthy resets the restart counter + give-up latch', () => {
    // Give up first.
    let state = initialFlapState('papercup-mcp-proxy.service');
    state = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: { result: 'start-limit-hit' }, state, autoRestartFlagOn: true, now: 0 }).nextState;
    expect(state.gaveUp).toBe(true);
    // Recovers at t=1000.
    state = decideReconcile({ entry: AUTORESTART_ENTRY, status: up('papercup-mcp-proxy.service'), show: undefined, state, autoRestartFlagOn: true, now: 1000 }).nextState;
    expect(state.gaveUp).toBe(true); // not reset yet — hasn't been healthy 5 min
    // Still healthy just under 5 minutes later — not reset yet.
    state = decideReconcile({ entry: AUTORESTART_ENTRY, status: up('papercup-mcp-proxy.service'), show: undefined, state, autoRestartFlagOn: true, now: 1000 + HEALTHY_RESET_MS - 1 }).nextState;
    expect(state.gaveUp).toBe(true);
    // Past 5 continuous minutes healthy — reset.
    state = decideReconcile({ entry: AUTORESTART_ENTRY, status: up('papercup-mcp-proxy.service'), show: undefined, state, autoRestartFlagOn: true, now: 1000 + HEALTHY_RESET_MS + 1 }).nextState;
    expect(state.gaveUp).toBe(false);
    expect(state.restarts).toEqual([]);
  });

  it('activating is treated as NOT down (never restart a unit mid-start)', () => {
    const activating: SystemctlUnitStatus = { unit: 'papercup-mcp-proxy.service', load: 'loaded', active: 'activating', sub: 'start', description: '' };
    const { action } = decideReconcile({ entry: AUTORESTART_ENTRY, status: activating, show: undefined, state: initialFlapState('papercup-mcp-proxy.service'), autoRestartFlagOn: true, now: 1000 });
    expect(action.kind).toBe('healthy');
  });
});

describe('checkRestartPolicyDrift (P-003(b) config-drift guard)', () => {
  it('report-only entry (autoRestart:false) never warns, regardless of the live Restart= value', () => {
    expect(checkRestartPolicyDrift(REPORT_ONLY_ENTRY, 'no', false)).toEqual({ warn: false, nextWarned: false });
    expect(checkRestartPolicyDrift(REPORT_ONLY_ENTRY, 'no', true)).toEqual({ warn: false, nextWarned: true });
  });

  it('no drift (Restart=always, matching the applied drop-in) -> no warn, latch clears', () => {
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, 'always', false)).toEqual({ warn: false, nextWarned: false });
    // Clears an existing latch too — a prior warn that's since been fixed should reset so a
    // future re-drift warns again instead of staying silently latched forever.
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, 'always', true)).toEqual({ warn: false, nextWarned: false });
  });

  it('unknown/unavailable Restart= (systemctl show call failed this tick) -> treated as no drift, no warn', () => {
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, undefined, false)).toEqual({ warn: false, nextWarned: false });
  });

  it('first drift observed (Restart=no, not yet warned) -> warns once, latches', () => {
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, 'no', false)).toEqual({ warn: true, nextWarned: true });
  });

  it('drift persists across ticks (already warned) -> no re-warn, latch stays set', () => {
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, 'no', true)).toEqual({ warn: false, nextWarned: true });
  });

  it('drift observed fixed after having warned -> latch clears, so a future re-drift warns again', () => {
    const fixed = checkRestartPolicyDrift(AUTORESTART_ENTRY, 'on-failure', true);
    expect(fixed).toEqual({ warn: false, nextWarned: false });
    // Simulate the drift recurring on a later tick — it warns again since the latch was cleared.
    const redrift = checkRestartPolicyDrift(AUTORESTART_ENTRY, 'no', fixed.nextWarned);
    expect(redrift).toEqual({ warn: true, nextWarned: true });
  });
});

describe('reconcileTick (orchestrator, mocked deps)', () => {
  beforeEach(() => {
    _resetReconcilerState();
  });

  function makeDeps(overrides: Partial<ReconcilerDeps> = {}): ReconcilerDeps & { execUser: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> } {
    const execUser = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
      if (args[0] === 'show') return 'Result=success\nNRestarts=0\n';
      if (args[0] === 'restart') return '';
      return '';
    });
    const notify = vi.fn(async () => {});
    return {
      execUser,
      notify,
      now: () => 1_000_000,
      autoRestartFlagOn: async () => true,
      registry: () => [AUTORESTART_ENTRY, REPORT_ONLY_ENTRY],
      log: () => {},
      ...overrides,
    } as ReconcilerDeps & { execUser: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
  }

  it('restarts a failed autoRestart:true unit and notifies; leaves the report-only entry alone', async () => {
    const deps = makeDeps();
    const result = await reconcileTick(deps);
    expect(result.checked).toBe(2);
    expect(result.degraded).toBe(false);
    // `entry.unit` is the BARE name (no `.service` suffix) — systemctl accepts either form, and
    // the reconciler passes the registry's bare form straight through.
    const restartCalls = deps.execUser.mock.calls.map((c) => c[0]).filter((args) => args[0] === 'restart');
    expect(restartCalls).toEqual([['restart', 'papercup-mcp-proxy']]);
    // The report-only entry (live-federation-gate, autoRestart:false) is down (inactive/dead in
    // the fixture) but must NEVER be restarted.
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'restart' && c[0][1] === 'papercup-live-federation-gate')).toBe(false);
    expect(deps.notify).toHaveBeenCalled();
  });

  it('does not restart when FLAGS.supervisorAutoRestart resolves false (report-only everywhere)', async () => {
    const deps = makeDeps({ autoRestartFlagOn: async () => false });
    await reconcileTick(deps);
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'restart')).toBe(false);
  });

  it('a systemctl list-units failure degrades to report-only + ONE warning, never throws', async () => {
    const deps = makeDeps({ execUser: vi.fn(async () => { throw new Error('user bus unreachable'); }) });
    const result = await reconcileTick(deps);
    expect(result.degraded).toBe(true);
    expect(result.checked).toBe(0);
    expect(deps.notify).toHaveBeenCalledTimes(1); // one-time warn, not a per-tick spam
    // A SECOND tick with the same failure does not warn again.
    const deps2 = { ...deps, execUser: deps.execUser, notify: deps.notify };
    await reconcileTick(deps2);
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it('never throws even when the restart command itself fails', async () => {
    const deps = makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
        if (args[0] === 'show') return 'Result=success\n';
        if (args[0] === 'restart') throw new Error('systemctl restart failed');
        return '';
      }),
    });
    await expect(reconcileTick(deps)).resolves.toBeDefined();
    expect(deps.notify).toHaveBeenCalled();
  });

  it('P-003(b): a supervised unit whose live Restart= has drifted to "no" gets a ONE-TIME escalation notify, not re-fired while still drifted', async () => {
    // mcp-proxy is UP+healthy in this variant (so the drift guard is exercised independently of
    // the down/restart path) but its live Restart= has drifted off the applied drop-in.
    const upFixture = [
      'papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy',
      '',
    ].join('\n');
    const deps = makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return upFixture;
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\nRestart=no\n';
        return '';
      }),
      registry: () => [AUTORESTART_ENTRY],
    });
    await reconcileTick(deps);
    const driftNotifies = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('Restart= policy has drifted'));
    expect(driftNotifies).toHaveLength(1);

    // A second tick, still drifted — must NOT re-notify (one-time until observed fixed).
    await reconcileTick(deps);
    const driftNotifiesAfter = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('Restart= policy has drifted'));
    expect(driftNotifiesAfter).toHaveLength(1);
  });

  it('P-003(b): once the drift is observed fixed, a later re-drift warns again', async () => {
    const upFixture = [
      'papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy',
      '',
    ].join('\n');
    let restartProp = 'no';
    const deps = makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return upFixture;
        if (args[0] === 'show') return `Result=success\nNRestarts=0\nRestart=${restartProp}\n`;
        return '';
      }),
      registry: () => [AUTORESTART_ENTRY],
    });
    await reconcileTick(deps); // drifted -> warns (1)
    restartProp = 'always'; // fixed
    await reconcileTick(deps); // fixed -> no warn, latch clears
    restartProp = 'no'; // drifts again
    await reconcileTick(deps); // re-drifted -> warns again (2)
    const driftNotifies = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('Restart= policy has drifted'));
    expect(driftNotifies).toHaveLength(2);
  });
});
