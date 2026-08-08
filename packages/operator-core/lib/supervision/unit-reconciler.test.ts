/**
 * unit-reconciler — failed-unit reconciler pure functions + orchestrator
 * (critical-process-supervisor-2026-07-04 P-002).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseSystemctlListUnits,
  parseSystemctlShowProperties,
  isUnitDown,
  isAdministrativelyPaused,
  decideReconcile,
  initialFlapState,
  reconcileTick,
  _resetReconcilerState,
  checkRestartPolicyDrift,
  checkSilentCrashLoop,
  BACKOFF_SEQUENCE_SEC,
  GIVE_UP_THRESHOLD,
  GIVE_UP_WINDOW_MS,
  HEALTHY_RESET_MS,
  SILENT_LOOP_THRESHOLD,
  SILENT_LOOP_WINDOW_MS,
  summarizeSystemctlStatusCause,
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

// WI-5378: the actual entry whose auto-heal (WI-5376) fought a deliberate pause.
const TIMER_ENTRY: SupervisionEntry = {
  name: 'live-federation-gate-timer',
  layer: 'systemd-user',
  unit: 'papercup-live-federation-gate.timer',
  criticality: 'important',
  autoRestart: true,
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

describe('summarizeSystemctlStatusCause', () => {
  it('extracts the most-recent concrete failure line from a restarted unit status', () => {
    expect(
      summarizeSystemctlStatusCause([
        'Active: active (running)',
        'Jul 13 10:52:48 host node[1]: Error: listen EADDRINUSE: address already in use 127.0.0.1:3070',
        'Jul 13 10:52:48 host systemd[1]: papercup-dev-api.service: Main process exited, code=exited, status=1/FAILURE',
        'Jul 13 10:53:19 host systemd[1]: Started papercup-dev-api.service',
      ].join('\n')),
    ).toContain('Main process exited, code=exited, status=1/FAILURE');
  });

  it('returns null when status has no failure evidence', () => {
    expect(summarizeSystemctlStatusCause('Active: active (running)\nStarted cleanly')).toBeNull();
  });

  // WI-9249 — the 2026-08-03 papercup-staging-api outage, verbatim in shape. The unit died in
  // ExecStartPre (a bundle failure), so it never started and the journal tail is all generic
  // systemd trailers. Picking one of those is TRUE and useless; only the `Process:` line names
  // the step that actually failed.
  const EXEC_START_PRE_FAILURE = [
    '× papercup-staging-api.service - Papercusp operator STAGING host (:3170)',
    'Active: failed (Result: exit-code) since Mon 2026-08-03 14:07:26 EDT; 13min ago',
    'Process: 904863 ExecStartPre=/home/x/papercusp/apps/operator/bin/bundle-host.sh (code=exited, status=1/FAILURE)',
    'Aug 03 14:13:03 host systemd[1]: papercup-staging-api.service: Start request repeated too quickly.',
    "Aug 03 14:13:03 host systemd[1]: papercup-staging-api.service: Failed with result 'exit-code'.",
    'Aug 03 14:13:03 host systemd[1]: Failed to start papercup-staging-api.service - Papercusp operator STAGING host (:3170).',
  ].join('\n');

  it('prefers a FAILED control-process line over the generic journal trailer', () => {
    const cause = summarizeSystemctlStatusCause(EXEC_START_PRE_FAILURE);
    // The whole point: it must name the failing STEP.
    expect(cause).toContain('ExecStartPre');
    expect(cause).toContain('bundle-host.sh');
    // ...and must NOT settle for the trailer, which is what the old ordering returned.
    expect(cause).not.toContain('Failed with result');
  });

  it('CONTROL: a SUCCESSFUL control process is not mistaken for the cause', () => {
    // A healthy ExecStartPre is also reported on a `Process:` line. Preferring `Process:`
    // blindly would report a step that SUCCEEDED as the failure.
    const output = [
      'Active: failed (Result: exit-code)',
      'Process: 111 ExecStartPre=/home/x/prep.sh (code=exited, status=0/SUCCESS)',
      'Aug 03 14:13:03 host systemd[1]: svc.service: Main process exited, code=exited, status=3/NOTIMPLEMENTED',
    ].join('\n');
    const cause = summarizeSystemctlStatusCause(output);
    expect(cause).not.toContain('prep.sh');
    expect(cause).toContain('status=3/NOTIMPLEMENTED');
  });

  it('CONTROL: with no control-process line the previous trailer behaviour is preserved', () => {
    const cause = summarizeSystemctlStatusCause(
      [
        'Active: active (running)',
        'Jul 13 10:52:48 host systemd[1]: svc.service: Main process exited, code=exited, status=1/FAILURE',
      ].join('\n'),
    );
    expect(cause).toContain('Main process exited, code=exited, status=1/FAILURE');
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

describe('isAdministrativelyPaused (WI-5378)', () => {
  it('disabled and masked are paused', () => {
    expect(isAdministrativelyPaused('disabled')).toBe(true);
    expect(isAdministrativelyPaused('masked')).toBe(true);
  });
  it('enabled/static/linked/generated/unknown/undefined are NOT paused', () => {
    for (const s of ['enabled', 'static', 'linked', 'generated', 'transient', 'bad', undefined]) {
      expect(isAdministrativelyPaused(s)).toBe(false);
    }
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

  it('unit not found by systemctl at all -> report-only "unit-not-found" (absence UNCONFIRMED without a show-probe)', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: undefined,
      show: undefined,
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    // WI-9871: no show-probe ⇒ we cannot claim the unit is really gone.
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'mcp-proxy',
      reason: 'unit-not-found',
      confirmedAbsent: false,
      notify: true,
    });
  });

  it('WI-9871: LoadState=not-found CONFIRMS absence -> unit-not-found with confirmedAbsent:true', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: undefined,
      show: { loadState: 'not-found' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'mcp-proxy',
      reason: 'unit-not-found',
      confirmedAbsent: true,
      notify: true,
    });
  });

  // ── WI-9871: the pause check must be reachable for a unit ABSENT from `list-units` ──
  //
  // `systemctl --user disable --now <unit>` — the DOCUMENTED way to pause the federation gate —
  // leaves the unit unloaded, so it vanishes from `list-units --all` and `status` is undefined.
  // Before this fix the `!status` branch returned `unit-not-found` and the WI-5378 pause check
  // was structurally unreachable, so a deliberate pause was reported as a missing unit file.
  it('WI-9871: a DISABLED unit absent from list-units is reported as paused, not "unit-not-found"', () => {
    const { action, nextState } = decideReconcile({
      entry: TIMER_ENTRY,
      status: undefined, // disabled + never started ⇒ absent from `list-units --all`
      show: { unitFileState: 'disabled', loadState: 'loaded' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'live-federation-gate-timer',
      reason: 'paused',
      notify: true,
    });
    // A pause is not a crash-loop: flap state resets, exactly as in the `status`-present path.
    expect(nextState.gaveUp).toBe(false);
    expect(nextState.restarts).toEqual([]);
  });

  it('WI-9871: a MASKED unit absent from list-units is likewise paused, not "unit-not-found"', () => {
    const { action } = decideReconcile({
      entry: TIMER_ENTRY,
      status: undefined,
      show: { unitFileState: 'masked', loadState: 'masked' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'live-federation-gate-timer',
      reason: 'paused',
      notify: true,
    });
  });

  it('WI-9871: an ENABLED unit absent from list-units is still unit-not-found (the pause branch must not over-claim)', () => {
    const { action } = decideReconcile({
      entry: TIMER_ENTRY,
      status: undefined,
      show: { unitFileState: 'enabled', loadState: 'not-found' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'live-federation-gate-timer',
      reason: 'unit-not-found',
      confirmedAbsent: true,
      notify: true,
    });
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

  it('WI-5378: down + autoRestart:true + disabled UnitFileState -> report-only "paused", never restart', () => {
    const { action, nextState } = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'success', unitFileState: 'disabled' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'report-only', unit: 'live-federation-gate-timer', reason: 'paused', notify: true });
    // Second tick, still paused — no re-notify (transition-only, like the other report-only paths).
    const r2 = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'success', unitFileState: 'disabled' },
      state: nextState,
      autoRestartFlagOn: true,
      now: 2000,
    });
    expect(r2.action).toEqual({ kind: 'report-only', unit: 'live-federation-gate-timer', reason: 'paused', notify: false });
  });

  it('WI-5378: masked UnitFileState is also treated as an intentional pause', () => {
    const { action } = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'success', unitFileState: 'masked' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'report-only', unit: 'live-federation-gate-timer', reason: 'paused', notify: true });
  });

  it('WI-5378: a unit that already gave up (crash-loop) but is then disabled is recognized as paused, not "already-escalated", and its flap state resets', () => {
    const gaveUp = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'start-limit-hit', unitFileState: 'enabled' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    }).nextState;
    expect(gaveUp.gaveUp).toBe(true);

    const paused = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'start-limit-hit', unitFileState: 'disabled' },
      state: gaveUp,
      autoRestartFlagOn: true,
      now: 2000,
    });
    expect(paused.action).toEqual({ kind: 'report-only', unit: 'live-federation-gate-timer', reason: 'paused', notify: false });
    expect(paused.nextState.gaveUp).toBe(false);
    expect(paused.nextState.restarts).toEqual([]);
    expect(paused.nextState.backoffIndex).toBe(0);
    expect(paused.nextState.lastRestartAt).toBeNull();
  });

  it('WI-5378: re-enabling a paused unit resumes normal restart behavior on the very next tick', () => {
    const paused = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'success', unitFileState: 'disabled' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    }).nextState;

    const resumed = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'success', unitFileState: 'enabled' },
      state: paused,
      autoRestartFlagOn: true,
      now: 2000,
    });
    expect(resumed.action).toEqual({ kind: 'restart', unit: 'live-federation-gate-timer', backoffSec: BACKOFF_SEQUENCE_SEC[0] });
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

describe('checkSilentCrashLoop (EI-10750 silent-crash-loop guard)', () => {
  it('a missing NRestarts reading carries state unchanged (no page, obs preserved)', () => {
    const obs = [{ at: 100, n: 3 }];
    const r = checkSilentCrashLoop(undefined, obs, false, 1000);
    expect(r).toEqual({ escalate: false, restartsInWindow: 0, nextObs: obs, nextEscalated: false });
  });

  it('a first observation of an already-high NRestarts does NOT page (no restarts seen DURING our window yet)', () => {
    // e.g. after an operator restart re-inits obs while systemd has long been at 43.
    const r = checkSilentCrashLoop(43, [], false, 1000);
    expect(r.escalate).toBe(false);
    expect(r.restartsInWindow).toBe(0);
    expect(r.nextObs).toEqual([{ at: 1000, n: 43 }]);
  });

  it('NRestarts climbing ≥ SILENT_LOOP_THRESHOLD within the window pages ONCE, then latches (no per-tick re-page)', () => {
    let obs: { at: number; n: number }[] = [];
    let escalated = false;
    let paged = 0;
    // 0..THRESHOLD, each 30s apart (all inside the five-minute window).
    for (let i = 0; i <= SILENT_LOOP_THRESHOLD; i++) {
      const r = checkSilentCrashLoop(i, obs, escalated, i * 30_000);
      obs = r.nextObs;
      escalated = r.nextEscalated;
      if (r.escalate) paged++;
    }
    expect(paged).toBe(1); // exactly one page, at the tick the delta first reaches the threshold
    // A further stable tick (NRestarts unchanged) must NOT re-page while still latched.
    const stable = checkSilentCrashLoop(SILENT_LOOP_THRESHOLD, obs, escalated, SILENT_LOOP_THRESHOLD * 30_000 + 5_000);
    expect(stable.escalate).toBe(false);
    expect(stable.nextEscalated).toBe(true);
  });

  it('below-threshold clears the latch so a fresh loop pages again', () => {
    // Loop-then-settle: once the early restarts age out of the window, the delta drops below
    // threshold and the latch clears.
    const settled = checkSilentCrashLoop(6, [{ at: 0, n: 6 }], true, SILENT_LOOP_WINDOW_MS + 1);
    // The only in-window observation is the fresh {now, 6}; delta 0 → below threshold → latch cleared.
    expect(settled.escalate).toBe(false);
    expect(settled.restartsInWindow).toBe(0);
    expect(settled.nextEscalated).toBe(false);
  });

  it('a DECREASE in NRestarts is treated as a systemd counter reset — fresh window + latch cleared', () => {
    const obs = [{ at: 0, n: 43 }, { at: 1000, n: 44 }];
    const r = checkSilentCrashLoop(0, obs, true, 2000);
    expect(r.nextObs).toEqual([{ at: 2000, n: 0 }]);
    expect(r.restartsInWindow).toBe(0);
    expect(r.escalate).toBe(false);
    expect(r.nextEscalated).toBe(false);
  });

  it('observations older than the five-minute window are pruned before computing the delta', () => {
    // An old {n:0} that has aged out must not inflate the in-window delta.
    const now = SILENT_LOOP_WINDOW_MS + 100_000;
    const obs = [{ at: 0, n: 0 }, { at: now - 60_000, n: 40 }];
    const r = checkSilentCrashLoop(41, obs, false, now);
    // Only the {n:40} obs is still in-window; delta = 41 - 40 = 1, below threshold.
    expect(r.restartsInWindow).toBe(1);
    expect(r.escalate).toBe(false);
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

  // WI-9249: these assert the SEAM (the escalation actually carries the cause), which the pure
  // summarizeSystemctlStatusCause tests above cannot reach.
  const STATUS_WITH_CAUSE = [
    'Active: failed (Result: exit-code)',
    'Process: 904863 ExecStartPre=/home/x/apps/operator/bin/bundle-host.sh (code=exited, status=1/FAILURE)',
    "Aug 03 14:13:03 host systemd[1]: papercup-mcp-proxy.service: Failed with result 'exit-code'.",
  ].join('\n');

  function depsWithStartLimit(statusImpl: (args: string[]) => Promise<string>) {
    return makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
        if (args[0] === 'show') return 'Result=start-limit-hit\nNRestarts=0\n';
        if (args[0] === 'status') return statusImpl(args);
        return '';
      }),
    });
  }

  it('an escalation page carries the failure CAUSE, not just "needs investigation"', async () => {
    const deps = depsWithStartLimit(async () => STATUS_WITH_CAUSE);
    await reconcileTick(deps);
    const page = deps.notify.mock.calls
      .map((c) => c[0].summary as string)
      .find((s) => s.includes('start-limit'));
    expect(page, 'expected a start-limit escalation').toBeDefined();
    // The regression this closes: the page used to end at "investigation" with no cause, so
    // every responder began from zero and re-ran journalctl by hand.
    expect(page).toContain('Cause:');
    expect(page).toContain('bundle-host.sh');
  });

  it('CONTROL: gathering diagnostics must never suppress the page itself', async () => {
    const deps = depsWithStartLimit(async () => {
      throw new Error('journal unreadable');
    });
    await reconcileTick(deps);
    const page = deps.notify.mock.calls
      .map((c) => c[0].summary as string)
      .find((s) => s.includes('start-limit'));
    // Still paged — the escalation is the load-bearing part, the cause is a bonus.
    expect(page).toBeDefined();
    expect(page).toContain('Cause unavailable');
  });

  // ── WI-9871 WIRING ────────────────────────────────────────────────────────
  //
  // The pure decideReconcile cases above all still pass if the tick never asks systemctl for
  // LoadState/UnitFileState, or never probes a unit missing from `list-units` — the fix would be
  // inert. These two assert the SEAM.

  it('WI-9871 WIRING: the show-probe requests LoadState, without which absence can never be confirmed', async () => {
    const deps = makeDeps();
    await reconcileTick(deps);
    const showCalls = deps.execUser.mock.calls.map((c) => c[0] as string[]).filter((a) => a[0] === 'show');
    expect(showCalls.length).toBeGreaterThan(0);
    for (const call of showCalls) {
      const props = call[call.indexOf('-p') + 1];
      expect(props).toContain('LoadState');
      expect(props).toContain('UnitFileState');
    }
  });

  it('WI-9871 WIRING: a registry unit ABSENT from list-units is show-probed and reported as PAUSED, not "removed/never installed"', async () => {
    // The live case: `disable --now` on the gate timer leaves it out of `list-units --all`
    // entirely, while `systemctl show` still resolves it as loaded-but-disabled.
    const deps = makeDeps({
      registry: () => [TIMER_ENTRY],
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return LIST_UNITS_FIXTURE; // contains NO .timer row
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\nUnitFileState=disabled\nLoadState=loaded\n';
        return '';
      }),
    });
    await reconcileTick(deps);

    // It must have been probed despite being absent from the listing.
    expect(deps.execUser.mock.calls.some((c) => (c[0] as string[])[0] === 'show')).toBe(true);
    // Never restarted — a pause is deliberate.
    expect(deps.execUser.mock.calls.some((c) => (c[0] as string[])[0] === 'restart')).toBe(false);

    const summaries = deps.notify.mock.calls.map((c) => c[0].summary as string);
    expect(summaries.some((s) => s.includes('administratively disabled/masked'))).toBe(true);
    // The regression this closes: a deliberate pause reported as a missing unit file.
    expect(summaries.some((s) => s.includes('removed/never installed'))).toBe(false);
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

  it('EI-11344: NRestarts climbing 8→12 in four minutes pages once with the last exit cause, even with auto-restart off', async () => {
    // The exact bug: papercup-staging-api crash-looped under systemd's own Restart= so fast that
    // every 60s reconciler tick saw it `active`. The down-path give-up counter never engaged — 43
    // restarts / 25 min of :3170 down, ZERO pages. Flag OFF (the real default) to prove the page is
    // independent of whether WE do the restarting.
    const upFixture = ['papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy', ''].join('\n');
    let nRestarts = 0;
    let now = 1_000_000;
    const deps = makeDeps({
      autoRestartFlagOn: async () => false,
      now: () => now,
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return upFixture;
        if (args[0] === 'show') return `Result=success\nNRestarts=${nRestarts}\nRestart=always\n`;
        if (args[0] === 'status') {
          return 'node:events: listen EADDRINUSE 127.0.0.1:3070\npapercup-dev-api.service: Main process exited, code=exited, status=1/FAILURE\n';
        }
        return '';
      }),
      registry: () => [AUTORESTART_ENTRY],
    });
    // Exact production incident shape: baseline 8, then four restarts in four minutes.
    for (let i = 0; i <= 4; i++) {
      nRestarts = 8 + i;
      await reconcileTick(deps);
      now += 60_000;
    }
    // One more stable tick (no further climb) must not re-page.
    await reconcileTick(deps);

    const silentPages = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('SILENTLY crash-looping'));
    expect(silentPages).toHaveLength(1);
    expect(String(silentPages[0][0].summary)).toContain('papercup-mcp-proxy');
    expect(String(silentPages[0][0].summary)).toContain('3× in <5min');
    expect(String(silentPages[0][0].summary)).toContain('Main process exited, code=exited, status=1/FAILURE');
    expect(silentPages[0][0].kind).toBe('escalation');
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'status')).toBe(true);
    // It read healthy at every tick — the down/restart path never engaged.
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'restart')).toBe(false);
  });

  it('WI-5378: a deliberately disabled autoRestart:true unit (the live-federation-gate timer, stopped+disabled to pause the gate) is NEVER restarted, and the reconciler reports the pause instead', async () => {
    const timerDisabledFixture = [
      'papercup-live-federation-gate.timer                loaded inactive dead    Nightly trigger for the live 2-peer federation gate',
      '',
    ].join('\n');
    const deps = makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return timerDisabledFixture;
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\nRestart=no\nUnitFileState=disabled\n';
        if (args[0] === 'restart') return '';
        return '';
      }),
      registry: () => [TIMER_ENTRY],
    });
    const result = await reconcileTick(deps);
    expect(result.checked).toBe(1);
    // The whole point of the fix: no restart call was ever issued against the paused timer.
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'restart')).toBe(false);
    const pausedNotifies = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('respecting the pause'));
    expect(pausedNotifies).toHaveLength(1);

    // A second tick, still disabled — no repeat restart attempt and no re-notify.
    await reconcileTick(deps);
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'restart')).toBe(false);
    const pausedNotifiesAfter = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('respecting the pause'));
    expect(pausedNotifiesAfter).toHaveLength(1);
  });
});
