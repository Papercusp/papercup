/**
 * estate-mirror-health-alarm-channels.test.ts — the RECURRENCE GUARD for the two
 * alert-integrity defects found under WI-10001692.
 *
 * Both are the same family, and it is the family this alert has now failed in
 * THREE times (WI-1038273, WI-2140790, WI-10001692): an alarm channel that cannot
 * tell a fault it has already reported from a new one, and so either shouts
 * forever or goes quiet forever. Neither failure announces itself — a stuck alarm
 * looks exactly like a live fault, and a gagged one looks exactly like health.
 *
 * DEFECT 1 — the same fault reported twice, at two different severities.
 *   A snapshot that fails verification is written into MIRROR-STATE.json BOTH as a
 *   run error (driving `ok:false`) and as a standing quarantine — one fact, two
 *   fields. do_health deliberately routes standing quarantines to stderr as NOTEs
 *   so a permanent fault is not re-broadcast every six hours, then re-raised that
 *   identical fact at full severity off `ok:false`, through an alarm whose text
 *   asserts "the backups are not being maintained" and ships fleet-wide with
 *   expects:"action". The asymmetry is what made it bite: MIRROR-STATE.json is
 *   rewritten by the DAILY mirror run while this probe fires 6-HOURLY, so one
 *   incomplete source snapshot produced four false backup-outage broadcasts a day
 *   until the next mirror run happened to clear `ok`.
 *
 * DEFECT 2 — a latch that could not stand down.
 *   ALERT-MIRROR-DEGRADED was removed only by the alert script's --resolved path,
 *   and that path was reached only when ALERT-MIRROR-FAILING had just been
 *   cleared — a marker the degraded path deliberately never writes. So the common
 *   case latched permanently. That is worse than a stale file: the alert script
 *   reads this marker's EXISTENCE as ALREADY_KNOWN and suppresses the fleet-wide
 *   channel, so a latch that cannot clear silently MUTES every future degraded
 *   alert. It fails in the direction where nobody is told.
 *
 * Unlike the sibling verify-tauri-headless-*.test.ts text guards, this suite RUNS
 * the subject: `health` mode reads one JSON file and touches marker files, so the
 * real behaviour is cheap to exercise and is far better evidence than asserting on
 * source text. Every case is hermetic — its own PC_ESTATE_MIRROR_ROOT under
 * tmpdir, and PC_ESTATE_MIRROR_ALERT pointed at a recording stub — so the suite
 * can never touch the live mirror at /mnt/data or broadcast to the fleet.
 *
 * The two `alarms anyway` cases are CALIBRATION, not padding: they are the
 * controls that fail if a future "fix" silences the channel wholesale. Measured
 * against the pre-fix script both flipped cases alarmed/latched and both
 * calibration cases behaved identically, so this suite is falsifiable in exactly
 * the two places it claims to guard.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY
// outside the tree, so falsifiability can be proven without ever mutating the
// shared checkout — where git-sync would happily commit the mutant mid-probe.
const SCRIPT =
  process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../infra/estate-backup/pc-estate-mirror.sh');

const FAILING = 'ALERT-MIRROR-FAILING';
const DEGRADED = 'ALERT-MIRROR-DEGRADED';

/** A stamp the probe can parse (`%Y%m%dT%H%M%S` off the first 15 chars). */
function stamp(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface HealthResult {
  exitCode: number | null;
  /** One entry per alert-script invocation, e.g. `--degraded` or `raise`. */
  alertModes: string[];
  markers: { failing: boolean; degraded: boolean };
}

/**
 * Run `pc-estate-mirror.sh health` against a throwaway root holding `state`.
 * `presetMarkers` seeds latches that a prior run would have left behind.
 */
function runHealth(state: unknown, presetMarkers: string[] = []): HealthResult {
  const root = mkdtempSync(join(tmpdir(), 'estate-mirror-health-'));
  roots.push(root);

  // A snapshot tree fresh enough that per-host age never contributes a problem —
  // the cases below must isolate the error/quarantine/latch logic, not freshness.
  const fresh = stamp(new Date(Date.now() - 60_000));
  mkdirSync(join(root, 'snapshots', 'hostA', fresh), { recursive: true });
  writeFileSync(join(root, 'MIRROR-STATE.json'), JSON.stringify(state));
  for (const m of presetMarkers) writeFileSync(join(root, m), 'preset by an earlier run\n');

  // Faithful to pc-estate-mirror-alert.sh's marker contract: raise writes the
  // FAILING marker, --degraded writes the DEGRADED one, --resolved clears the
  // degraded latch (the caller has already removed FAILING — that removal is what
  // proves recovery). Recording the MODE is the point: which channel fired is the
  // whole verdict, and it is exactly what the fleet-wide broadcast is chosen from.
  const alert = join(root, 'alert-stub.sh');
  const log = join(root, 'alert-calls.log');
  writeFileSync(
    alert,
    [
      '#!/usr/bin/env bash',
      'MODE="raise"',
      'case "${1:-}" in --resolved|--degraded) MODE="$1"; shift ;; esac',
      `printf '%s\\n' "$MODE" >> ${JSON.stringify(log)}`,
      `R=${JSON.stringify(root)}`,
      'case "$MODE" in',
      `  --resolved) rm -f "$R/${DEGRADED}" ;;`,
      `  --degraded) echo degraded > "$R/${DEGRADED}" ;;`,
      `  *) echo failing > "$R/${FAILING}" ;;`,
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(alert, 0o755);

  const run = spawnSync('bash', [SCRIPT, 'health'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PC_ESTATE_MIRROR_ROOT: root,
      PC_ESTATE_MIRROR_ALERT: alert,
    },
  });

  let alertModes: string[] = [];
  try {
    alertModes = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } catch {
    alertModes = []; // never invoked — the stub only creates the log when it runs
  }

  const exists = (name: string): boolean => {
    try {
      readFileSync(join(root, name));
      return true;
    } catch {
      return false;
    }
  };
  return {
    exitCode: run.status,
    alertModes,
    markers: { failing: exists(FAILING), degraded: exists(DEGRADED) },
  };
}

/** A state file that is healthy on every axis the probe checks. */
function healthyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    last_run_at: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ok: true,
    sealed: true,
    free_gb: 999,
    errors: [],
    quarantined: [],
    hosts: { hostA: { count: 1, newest: stamp(new Date(Date.now() - 60_000)) } },
    ...overrides,
  };
}

const QUARANTINE_KEY = 'hetzner-restore-prod/20260829T055415Z';
/** The real shape from the live mirror: one fact written into BOTH fields. */
const standingQuarantineState = healthyState({
  ok: false,
  errors: [
    `${QUARANTINE_KEY}: VERIFY FAILED (source_incomplete) — quarantined: ` +
      'pg/restart-postgres-1__restart.dump: MISSING;',
  ],
  quarantined: [
    {
      host: 'hetzner-restore-prod',
      taken_at: '20260829T055415Z',
      classification: 'source_incomplete',
      attempts: 1,
    },
  ],
});

describe('WI-10001692 — estate-mirror health picks exactly one alarm channel per fault', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toContain('pc-estate-mirror.sh');
  });

  describe('defect 1: a standing quarantine is reported once, not through two channels', () => {
    it('does not re-raise a backup-outage alarm for a quarantine already on the books', () => {
      const r = runHealth(standingQuarantineState);

      // The load-bearing assertion. `ok:false` here carries ONLY the quarantine
      // fact, which the stderr NOTE channel is already reporting; raising the
      // fleet-wide alarm as well claims a single-provider backup outage that the
      // very same state file shows is not happening.
      expect(r.alertModes).toEqual([]);
      expect(r.markers.failing).toBe(false);
      expect(r.exitCode).toBe(0);
    });

    it('alarms anyway when an error is NOT attributable to a standing quarantine', () => {
      // CALIBRATION: proves the case above suppresses by ATTRIBUTION, not by
      // ignoring `ok:false`. Without this, silencing the channel outright would
      // pass the suite.
      const r = runHealth(healthyState({ ok: false, errors: ['tools/ sync failed'] }));

      expect(r.alertModes).toEqual(['raise']);
      expect(r.markers.failing).toBe(true);
      expect(r.exitCode).toBe(1);
    });

    it('alarms on a real error that rides ALONGSIDE a standing quarantine', () => {
      // The mixed case: subtraction must remove only the accounted-for fact and
      // leave the genuine failure alarming. A naive "any quarantine ⇒ stay quiet"
      // fix passes both cases above and silently loses this one.
      const r = runHealth(
        healthyState({
          ok: false,
          errors: [...(standingQuarantineState.errors as string[]), 'tools/ sync failed'],
          quarantined: standingQuarantineState.quarantined,
        }),
      );

      expect(r.alertModes).toEqual(['raise']);
      expect(r.exitCode).toBe(1);
    });

    it('still reports an ok:false state file that lists no errors at all', () => {
      // Subtraction must never be able to reach "silent" through an inconsistent
      // state file — an unexplained ok:false is itself the finding.
      const r = runHealth(healthyState({ ok: false, errors: [] }));

      expect(r.alertModes).toEqual(['raise']);
      expect(r.exitCode).toBe(1);
    });
  });

  describe('defect 2: the degraded latch can stand down on its own', () => {
    it('clears a stranded ALERT-MIRROR-DEGRADED when the probe is healthy again', () => {
      // The pre-fix path: DEGRADED set, FAILING never written by the degraded
      // branch, so recovery found nothing to clear, never stood down, and left the
      // latch — which then gags every future degraded alert as ALREADY_KNOWN.
      const r = runHealth(healthyState(), [DEGRADED]);

      expect(r.markers.degraded).toBe(false);
      expect(r.alertModes).toEqual(['--resolved']);
      expect(r.exitCode).toBe(0);
    });

    it('clears a stranded ALERT-MIRROR-FAILING too, and stands down once', () => {
      const r = runHealth(healthyState(), [FAILING]);

      expect(r.markers.failing).toBe(false);
      expect(r.alertModes).toEqual(['--resolved']);
      expect(r.exitCode).toBe(0);
    });

    it('clears BOTH latches with a single stand-down, not one per marker', () => {
      const r = runHealth(healthyState(), [FAILING, DEGRADED]);

      expect(r.markers).toEqual({ failing: false, degraded: false });
      expect(r.alertModes).toEqual(['--resolved']);
    });

    it('stays silent on an ordinary healthy run with no latch to retract', () => {
      // CALIBRATION: the stand-down must fire only on a real transition. A
      // stand-down every six hours would be its own spam — the failure mode one
      // level up from the one this file fixes.
      const r = runHealth(healthyState());

      expect(r.alertModes).toEqual([]);
      expect(r.exitCode).toBe(0);
    });
  });

  describe('calibration: the freshness detector still fails when it should', () => {
    it('alarms when the last mirror run is older than the age limit', () => {
      // If this ever goes quiet, every "no alarm" above is meaningless — it would
      // mean the probe stopped measuring, not that the mirror is healthy.
      const r = runHealth(healthyState({ last_run_at: '2026-01-01T00:00:00Z' }));

      expect(r.alertModes).toEqual(['raise']);
      expect(r.exitCode).toBe(1);
    });
  });
});
