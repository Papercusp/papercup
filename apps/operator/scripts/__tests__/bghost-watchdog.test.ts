import { describe, it, expect, beforeAll } from 'vitest';

// Don't let the watchdog's poll loop auto-start on import — exercise the pure decision logic only.
process.env.PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART = '1';

let parseIdleSec: (s: unknown) => number | null;
let isFrozen: (idleSec: number | null | undefined, freezeSilenceS?: number) => boolean;
let resolveDbUrl: (readFile?: (p: string, enc: string) => string) => string | null;
let shouldRestart: (idleSec: number | null, schedSec: number | null, freezeSilenceS?: number) => boolean;
let withinBootGrace: (activeForSec: number | null | undefined, bootGraceMs?: number) => boolean;
let nextDebounceMs: (baseMs: number, consecutiveRestarts: number, multiplier?: number, capMs?: number) => number;
let shouldAlert: (consecutiveRestarts: number, alertAfter?: number) => boolean;
let alertFleet: (
  summary: string,
  deps?: {
    dbUrl?: string | null;
    sh?: (cmd: string, args: string[], opts?: { stdin?: string }) => Promise<{ err: Error | null; stdout: string; stderr?: string }>;
    log?: (m: string) => void;
  },
) => Promise<boolean>;
let circuitOpenMessage: (
  reason: string,
  restartCount: number,
  cap: number,
  snapshot?: { cores: number; load1: number; loadPerCore: number; availableRatio: number; hasHeadroom: boolean } | null,
) => string;
type CollateralEntry = { pid: number; cmdline: string };
type CollateralSummary = {
  total: number;
  own: number;
  spawner: number;
  desktop: number;
  other: number;
  collateral: number;
  otherSample: string[];
};
let parseCgroupProcs: (text: unknown) => number[];
let classifyCollateral: (entries: CollateralEntry[] | null | undefined) => CollateralSummary | null;
let collateralAlertMessage: (unit: string, summary: CollateralSummary | null, reason: string) => string | null;
let readCollateral: (deps?: {
  sh?: (cmd: string, args: string[]) => Promise<{ err: Error | null; stdout: string; stderr?: string }>;
  readFile?: (p: string, enc: string) => string;
  unit?: string;
}) => Promise<CollateralSummary | null>;
beforeAll(async () => {
  ({
    parseIdleSec,
    isFrozen,
    resolveDbUrl,
    shouldRestart,
    withinBootGrace,
    nextDebounceMs,
    shouldAlert,
    alertFleet,
    circuitOpenMessage,
    parseCgroupProcs,
    classifyCollateral,
    collateralAlertMessage,
    readCollateral,
  } = await import('../bghost-watchdog.mjs'));
});

/**
 * EI-2434: the bg-host watchdog used to restart on journalctl SILENCE, which a wedged journald faked on a
 * HEALTHY ticker → false restart → EI-2186 reclaimed in-flight bees. It now keys on the PG routine
 * fire-freshness (journald-independent). The critical invariant: a MISSING/UNKNOWN signal must NEVER be
 * read as "frozen" (that asymmetry is the whole bug class).
 */
describe('bghost-watchdog — journald-independent freeze signal (EI-2434)', () => {
  describe('parseIdleSec', () => {
    it('parses a numeric idle-seconds scalar', () => expect(parseIdleSec('32\n')).toBe(32));
    it('parses 0 (just fired)', () => expect(parseIdleSec('0')).toBe(0));
    it('empty (no active routines) ⇒ UNKNOWN(null)', () => {
      expect(parseIdleSec('')).toBeNull();
      expect(parseIdleSec('   \n')).toBeNull();
    });
    it('NULL (no fires yet) ⇒ UNKNOWN(null)', () => {
      expect(parseIdleSec('null')).toBeNull();
      expect(parseIdleSec('NULL\n')).toBeNull();
    });
    it('junk / undefined ⇒ UNKNOWN(null)', () => {
      expect(parseIdleSec('xyz')).toBeNull();
      expect(parseIdleSec(undefined)).toBeNull();
    });
  });

  describe('isFrozen', () => {
    it('fresh (idle < threshold) ⇒ not frozen', () => {
      expect(isFrozen(3, 100)).toBe(false);
      expect(isFrozen(32, 100)).toBe(false);
    });
    it('exactly at threshold ⇒ not frozen', () => expect(isFrozen(100, 100)).toBe(false));
    it('over threshold ⇒ frozen', () => {
      expect(isFrozen(101, 100)).toBe(true);
      expect(isFrozen(600, 100)).toBe(true);
    });
    it('UNKNOWN(null/undefined) is NEVER frozen — the core EI-2434 fix', () => {
      expect(isFrozen(null, 100)).toBe(false);
      expect(isFrozen(undefined, 100)).toBe(false);
    });
  });

  /**
   * 2026-06-23 routines-queue-saturation false-restart fix: a stale routine `last_fired_at` alone is
   * ambiguous — it means a genuine freeze OR a SATURATED fire-queue (legit long routines holding every
   * `routines` slot). Restarting during saturation killed the long routines mid-run + re-saturated → a
   * 5-min restart LOOP that froze git-sync/deploys for hours. `shouldRestart` corroborates with the
   * SCHEDULER (routinesTick) liveness: restart ONLY when fires are stale AND the scheduler is not
   * confirmed-fresh (a real freeze stalls both; saturation leaves the scheduler ticking).
   */
  describe('shouldRestart — saturation vs freeze (2026-06-23)', () => {
    it('healthy fires ⇒ never restart (regardless of scheduler)', () => {
      expect(shouldRestart(3, 3, 100)).toBe(false);
      expect(shouldRestart(32, 999, 100)).toBe(false);
    });
    it('UNKNOWN fires (null) ⇒ never restart', () => {
      expect(shouldRestart(null, null, 100)).toBe(false);
      expect(shouldRestart(null, 999, 100)).toBe(false);
    });
    it('SATURATION: fires stale BUT scheduler fresh ⇒ NOT a freeze, do not restart (the core fix)', () => {
      expect(shouldRestart(267, 29, 100)).toBe(false);
      expect(shouldRestart(600, 100, 100)).toBe(false); // scheduler exactly at threshold = still fresh
    });
    it('GENUINE FREEZE: fires stale AND scheduler also stale ⇒ restart', () => {
      expect(shouldRestart(267, 267, 100)).toBe(true);
      expect(shouldRestart(150, 101, 100)).toBe(true);
    });
    it('fires stale + scheduler UNKNOWN(null) ⇒ restart (fall back to the documented fire-staleness net)', () => {
      expect(shouldRestart(267, null, 100)).toBe(true);
    });
  });

  /**
   * EI-8901: the staleness signal (routine last_fired_at / routinesTick) is read from PG and SPANS process
   * restarts, so a freshly-restarted unit that hasn't ticked yet still reads as frozen — under load, boot
   * takes longer than the restart debounce, so every new generation gets judged frozen before it can
   * possibly tick → a restart storm. `withinBootGrace` gates the freeze judgment on how long the unit has
   * actually been in its current active generation (systemd's own ActiveEnterTimestampMonotonic), so a
   * unit still booting is never mistaken for "frozen".
   */
  describe('withinBootGrace — restart-storm fix (EI-8901)', () => {
    it('just restarted (well under the grace window) ⇒ within grace', () => {
      expect(withinBootGrace(5, 8 * 60_000)).toBe(true);
      expect(withinBootGrace(0, 8 * 60_000)).toBe(true);
    });
    it('past the grace window ⇒ not within grace (judge normally)', () => {
      expect(withinBootGrace(9 * 60, 8 * 60_000)).toBe(false);
      expect(withinBootGrace(3600, 8 * 60_000)).toBe(false);
    });
    it('exactly at the grace boundary ⇒ not within grace (>= is the cutoff)', () => {
      expect(withinBootGrace(8 * 60, 8 * 60_000)).toBe(false);
    });
    it('UNKNOWN active-for (null/undefined) ⇒ NEVER within grace — never invent suppression from a missing signal', () => {
      expect(withinBootGrace(null, 8 * 60_000)).toBe(false);
      expect(withinBootGrace(undefined, 8 * 60_000)).toBe(false);
    });
    it('a negative active-for (clock skew / bad read) ⇒ not within grace', () => {
      expect(withinBootGrace(-5, 8 * 60_000)).toBe(false);
    });
  });

  /**
   * WI-3630: EI-8901's boot-grace stops the common storm case, but a boot slower than the grace window
   * would still hit the OLD flat debounce and get re-killed right as it might finish. `nextDebounceMs`
   * backs off exponentially per consecutive restart (capped) so an unusually slow boot gets progressively
   * more room; `shouldAlert` fires well before the hard hourly circuit breaker so a developing storm is
   * visible early, not only once fully tripped.
   */
  describe('nextDebounceMs — exponential backoff per consecutive strike (WI-3630)', () => {
    it('first strike (0 consecutive so far) ⇒ the base debounce, unscaled', () => {
      expect(nextDebounceMs(5 * 60_000, 0, 2, 30 * 60_000)).toBe(5 * 60_000);
    });
    it('doubles per consecutive strike', () => {
      expect(nextDebounceMs(5 * 60_000, 1, 2, 30 * 60_000)).toBe(10 * 60_000);
      expect(nextDebounceMs(5 * 60_000, 2, 2, 30 * 60_000)).toBe(20 * 60_000);
    });
    it('caps at capMs — never grows unbounded', () => {
      expect(nextDebounceMs(5 * 60_000, 10, 2, 30 * 60_000)).toBe(30 * 60_000);
    });
    it('a negative/garbage strike count is treated as 0 (never SHRINKS the debounce below base)', () => {
      expect(nextDebounceMs(5 * 60_000, -3, 2, 30 * 60_000)).toBe(5 * 60_000);
    });
  });

  describe('shouldAlert — early storm visibility, ahead of the hard circuit breaker (WI-3630)', () => {
    it('under the alert threshold ⇒ no alert yet', () => {
      expect(shouldAlert(0, 2)).toBe(false);
      expect(shouldAlert(1, 2)).toBe(false);
    });
    it('at or over the alert threshold ⇒ alert', () => {
      expect(shouldAlert(2, 2)).toBe(true);
      expect(shouldAlert(5, 2)).toBe(true);
    });
    it('fires well before the hourly circuit-breaker cap (8) so a developing storm is caught early', () => {
      expect(shouldAlert(2, 2)).toBe(true); // default ALERT_AFTER_RESTARTS=2 << default MAX_RESTARTS_PER_HR=8
    });
  });

  describe('alertFleet — best-effort fleet-wide broadcast (WI-3630)', () => {
    it('inserts into coord_event_log via psql -v bind-variables with the SQL on STDIN (never raw string interpolation)', async () => {
      const calls: Array<{ cmd: string; args: string[]; opts?: { stdin?: string } }> = [];
      const sh = async (cmd: string, args: string[], opts?: { stdin?: string }) => {
        calls.push({ cmd, args, opts });
        return { err: null, stdout: '', stderr: '' };
      };
      const ok = await alertFleet('test alert body', { dbUrl: 'postgresql://test', sh, log: () => {} });
      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('psql');
      expect(calls[0].args[0]).toBe('postgresql://test');
      // bind-variable args, not interpolated straight into the SQL string
      expect(calls[0].args).toContain('-v');
      const jsonBodyArg = calls[0].args.find((a) => a.startsWith('jsonbody='));
      expect(jsonBodyArg).toBeDefined();
      const parsed = JSON.parse(jsonBodyArg!.slice('jsonbody='.length));
      expect(parsed).toMatchObject({ from: 'system-watchdog', to: ['*'], kind: 'message', summary: 'test alert body', category: 'severe-event' });
      const sql = calls[0].opts?.stdin ?? '';
      expect(sql).toContain('harness_shared.coord_event_log');
      expect(sql).not.toContain('test alert body'); // never raw-interpolated into the SQL text itself
    });

    it('delivers the SQL via stdin, NEVER -c — psql does not interpolate -v variables in -c strings (EI-9419)', async () => {
      // Regression guard for the 2026-07-10 DBOS outage: alertFleet used `-c "... :'msgid' ..."`,
      // psql sent the :'var' references to the server LITERALLY ("syntax error at or near :"), and
      // every fleet alert since WI-3630 landed failed silently — the 63-min outage went unalerted.
      // -v variables only interpolate in stdin/-f input; pin that delivery shape.
      const calls: Array<{ args: string[]; opts?: { stdin?: string } }> = [];
      const sh = async (_cmd: string, args: string[], opts?: { stdin?: string }) => {
        calls.push({ args, opts });
        return { err: null, stdout: '', stderr: '' };
      };
      const ok = await alertFleet('test alert body', { dbUrl: 'postgresql://test', sh, log: () => {} });
      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].args).not.toContain('-c'); // the bug: -v vars are silently ignored under -c
      expect(calls[0].args).toContain('-f'); // SQL arrives as a stream…
      expect(calls[0].args).toContain('-'); // …specifically stdin
      const sql = calls[0].opts?.stdin ?? '';
      expect(sql).toContain(":'msgid'"); // bind-variable references live in the piped SQL
      expect(sql).toContain(":'jsonbody'");
    });

    it('surfaces psql stderr in the failure log line (delivery failures must be diagnosable)', async () => {
      const logs: string[] = [];
      const sh = async () => ({ err: new Error('Command failed: psql'), stdout: '', stderr: 'ERROR:  syntax error at or near ":"' });
      const ok = await alertFleet('test alert body', { dbUrl: 'postgresql://test', sh, log: (m: string) => logs.push(m) });
      expect(ok).toBe(false);
      expect(logs.some((l) => l.includes('syntax error at or near'))).toBe(true);
    });

    it('never throws on a failed insert — fail-soft (a broadcast failure must not break the watchdog)', async () => {
      const logs: string[] = [];
      const sh = async () => ({ err: new Error('psql: connection refused'), stdout: '' });
      const ok = await alertFleet('test alert body', { dbUrl: 'postgresql://test', sh, log: (m: string) => logs.push(m) });
      expect(ok).toBe(false);
      expect(logs.some((l) => l.includes('FAILED'))).toBe(true);
    });

    it('skips (never throws) when no DB url is resolvable', async () => {
      const logs: string[] = [];
      const ok = await alertFleet('test alert body', { dbUrl: null, sh: async () => ({ err: null, stdout: '' }), log: (m: string) => logs.push(m) });
      expect(ok).toBe(false);
      expect(logs.some((l) => l.includes('SKIPPED'))).toBe(true);
    });
  });

  describe('resolveDbUrl', () => {
    const save = () => [process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL, process.env.DATABASE_URL] as const;
    const restore = ([a, b]: readonly [string | undefined, string | undefined]) => {
      a === undefined ? delete process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL : (process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL = a);
      b === undefined ? delete process.env.DATABASE_URL : (process.env.DATABASE_URL = b);
    };

    it('prefers the explicit DB_URL override', () => {
      const s = save();
      process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL = 'postgresql://override';
      expect(resolveDbUrl(() => 'DATABASE_URL=postgresql://file')).toBe('postgresql://override');
      restore(s);
    });

    it('parses DATABASE_URL out of a .env.local (export prefix + quotes stripped)', () => {
      const s = save();
      delete process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL;
      delete process.env.DATABASE_URL;
      const read = () => 'FOO=1\nexport DATABASE_URL="postgresql://harness_admin:pw@localhost:5432/papercusp"\nBAR=2\n';
      expect(resolveDbUrl(read)).toBe('postgresql://harness_admin:pw@localhost:5432/papercusp');
      restore(s);
    });

    it('returns null when nothing is resolvable (no env, unreadable file)', () => {
      const s = save();
      delete process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL;
      delete process.env.DATABASE_URL;
      expect(
        resolveDbUrl(() => {
          throw new Error('no .env.local');
        }),
      ).toBeNull();
      restore(s);
    });
  });

  describe('circuitOpenMessage — EI-4027 diagnosis', () => {
    it('does not misdiagnose a headroom host as fleet load/thrashing', () => {
      const message = circuitOpenMessage('ticker genuinely frozen', 8, 8, {
        cores: 128,
        load1: 25,
        loadPerCore: 25 / 128,
        availableRatio: 0.35,
        hasHeadroom: true,
      });

      expect(message).toContain('Host has headroom');
      expect(message).toContain('bg-host ticker/event-loop/DBOS stall');
      expect(message).toContain('ticker genuinely frozen');
      expect(message).not.toMatch(/thrashing|reduce load/i);
    });
  });
});

/**
 * EI-19485006080051257 — the watchdog alerted on restart STORMS but never on COLLATERAL.
 *
 * A restart tears down the unit's whole cgroup (KillMode=control-group), which also holds the agent
 * spawner and the owner's LIVE desktop-app sidecars. The storm alert needs ALERT_AFTER_RESTARTS (2)
 * consecutive strikes and the counter resets on the first healthy poll, so the ORDINARY case — one
 * freeze, one restart, clean recovery — could never alert. The better the watchdog worked, the more
 * certainly the damage went unreported.
 *
 * The invariant these tests pin: "is a storm developing?" (debounced, correctly) and "did we just
 * destroy something that was not ours?" (irreversible, first occurrence) must never share a threshold.
 */
describe('bghost-watchdog — collateral reporting (EI-19485006080051257)', () => {
  // The real cgroup shape, measured 2026-08-04T01:35Z on the live box.
  const MEASURED: CollateralEntry[] = [
    { pid: 35422, cmdline: 'npm exec tsx bin/hono-host.ts' },
    { pid: 35685, cmdline: 'node /w/papercusp/node_modules/.bin/tsx bin/hono-host.ts' },
    { pid: 37652, cmdline: '/w/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.27.3' },
    { pid: 45576, cmdline: 'npm exec tsx /w/papercusp/apps/operator/bin/spawner-sidecar.ts' },
    { pid: 45951, cmdline: 'node /w/papercusp/node_modules/.bin/tsx /w/.../spawner-sidecar.ts' },
    { pid: 271234, cmdline: '/mnt/data/.../Papercusp GUI_0.0.13_amd64/data/usr/lib/Papercusp GUI/serve.mjs' },
    { pid: 274143, cmdline: '/mnt/data/.../Papercusp GUI_0.0.13_amd64/data/usr/lib/Papercusp GUI/serve.mjs' },
    { pid: 2808712, cmdline: 'pg_dump papercusp' },
  ];

  describe('parseCgroupProcs', () => {
    it('parses one pid per line', () => expect(parseCgroupProcs('35422\n45576\n271234\n')).toEqual([35422, 45576, 271234]));
    it('an empty cgroup.procs yields no pids', () => expect(parseCgroupProcs('')).toEqual([]));
    it('drops junk/blank lines rather than throwing — this runs on the restart path', () => {
      expect(parseCgroupProcs('35422\n\nnot-a-pid\n0\n-5\n45576\n')).toEqual([35422, 45576]);
    });
    it('null/undefined input is empty, never a throw', () => {
      expect(parseCgroupProcs(null)).toEqual([]);
      expect(parseCgroupProcs(undefined)).toEqual([]);
    });
  });

  describe('classifyCollateral', () => {
    it('separates the unit OWN processes from what a restart destroys', () => {
      const s = classifyCollateral(MEASURED)!;
      expect(s.own).toBe(3); // 2x hono-host + esbuild
      expect(s.spawner).toBe(2);
      expect(s.desktop).toBe(2);
      expect(s.other).toBe(1); // pg_dump
      expect(s.collateral).toBe(5);
      expect(s.total).toBe(8);
    });

    it('an unrecognised process counts as COLLATERAL, never assumed benign', () => {
      // Assuming-benign is the direction that would re-create the original silence.
      const s = classifyCollateral([{ pid: 1, cmdline: '/usr/bin/something-nobody-anticipated --flag' }])!;
      expect(s.other).toBe(1);
      expect(s.collateral).toBe(1);
      expect(s.own).toBe(0);
    });

    it('a cgroup holding ONLY the unit itself has no collateral (a benign restart)', () => {
      const s = classifyCollateral([
        { pid: 1, cmdline: 'npm exec tsx bin/hono-host.ts' },
        { pid: 2, cmdline: 'esbuild --service=0.27.3' },
      ])!;
      expect(s.collateral).toBe(0);
      expect(s.own).toBe(2);
    });

    it('empty/null input is UNKNOWN(null) — never a zeroed summary that reads as "nothing died"', () => {
      expect(classifyCollateral([])).toBeNull();
      expect(classifyCollateral(null)).toBeNull();
      expect(classifyCollateral(undefined)).toBeNull();
    });

    it('bounds the other-process sample so the alert cannot grow unbounded', () => {
      const many = Array.from({ length: 20 }, (_, i) => ({ pid: 1000 + i, cmdline: `/usr/bin/job-${i}` }));
      const s = classifyCollateral(many)!;
      expect(s.other).toBe(20);
      expect(s.otherSample).toHaveLength(3);
    });
  });

  describe('collateralAlertMessage', () => {
    it('names the agent spawner and the desktop sidecars explicitly', () => {
      const msg = collateralAlertMessage('papercup-bg-host', classifyCollateral(MEASURED), 'ticker frozen')!;
      expect(msg).toContain('AGENT SPAWNER');
      expect(msg).toContain('2 LIVE desktop-app sidecars');
      expect(msg).toContain('KILLED 5 process(es)');
      expect(msg).toContain('ticker frozen');
      // Must not read as a misfire — the restart itself was correct; the collateral is the news.
      expect(msg).toContain('NOT a restart-storm alert');
    });

    it('says NOTHING when the restart destroys only the unit itself', () => {
      const benign = classifyCollateral([{ pid: 1, cmdline: 'npm exec tsx bin/hono-host.ts' }]);
      expect(collateralAlertMessage('papercup-bg-host', benign, 'frozen')).toBeNull();
    });

    it('says NOTHING on an UNKNOWN snapshot — never infer destruction from a missing signal', () => {
      expect(collateralAlertMessage('papercup-bg-host', null, 'frozen')).toBeNull();
    });
  });

  describe('THE REGRESSION GUARD: collateral must not share the storm threshold', () => {
    it('a FIRST restart reports collateral even though shouldAlert() is still false', () => {
      // This is the exact defect. consecutiveRestarts === 1 after the first restart, and
      // ALERT_AFTER_RESTARTS is 2, so the storm alert stays silent — as designed.
      expect(shouldAlert(1)).toBe(false);
      // ...but the collateral notice must fire regardless, or a lone restart kills the owner's
      // desktop with no signal anywhere. Before this fix, nothing was emitted here at all.
      expect(collateralAlertMessage('papercup-bg-host', classifyCollateral(MEASURED), 'frozen')).not.toBeNull();
    });

    it('CONTROL: a threshold-gated collateral signal would be silent here — proving the guard bites', () => {
      // Deliberately-wrong implementation kept as a control: if collateral reporting were ever
      // re-coupled to the storm counter, this is what the first restart would produce.
      const wrong = (strikes: number) => (shouldAlert(strikes) ? collateralAlertMessage('u', classifyCollateral(MEASURED), 'r') : null);
      expect(wrong(1)).toBeNull(); // the bug: silent on the case that actually happens
      expect(wrong(2)).not.toBeNull();
      // The shipped implementation is independent of the strike count entirely.
      expect(collateralAlertMessage('u', classifyCollateral(MEASURED), 'r')).not.toBeNull();
    });
  });

  /**
   * The tests above exercise the pure functions. They would ALL still pass if someone deleted the call
   * from `restart()` — so on their own they do not protect the behaviour, only the helpers. `restart()`
   * cannot be imported (it is module-private and really shells out to `systemctl restart`), so this
   * asserts the wiring at the source level, the same chokepoint approach as
   * papercusp-desktop/test/tauri-dev-slot-chokepoint.test.js.
   */
  describe('WIRING: the restart path must actually emit collateral, ungated', () => {
    let src: string;
    let restartBody: string;
    beforeAll(async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      // PROBE_SCRIPT lets scripts/mutation-probe.sh point this at a MUTATED COPY outside the tree, so
      // falsifiability can be proven without ever mutating the shared working tree (git-sync would
      // commit the mutant mid-probe).
      const subject = process.env.PROBE_SCRIPT || resolve(dirname(fileURLToPath(import.meta.url)), '../bghost-watchdog.mjs');
      src = readFileSync(subject, 'utf8');
      // The restart() function body: from its declaration to the next top-level `async function`.
      const start = src.indexOf('function restart(');
      expect(start).toBeGreaterThan(-1);
      restartBody = src.slice(start, src.indexOf('\nasync function poll(', start));
      expect(restartBody.length).toBeGreaterThan(0);
    });

    it('restart() emits a collateral message', () => {
      expect(restartBody).toContain('collateralAlertMessage(');
    });

    it('the collateral emit is NOT nested inside the shouldAlert() storm branch', () => {
      // The whole defect was one signal gating the other. If a future edit moves the collateral emit
      // inside `if (shouldAlert(...)) { ... }`, the ordinary one-restart case goes silent again.
      const stormIdx = restartBody.indexOf('if (shouldAlert(');
      const collateralIdx = restartBody.indexOf('collateralAlertMessage(');
      expect(stormIdx).toBeGreaterThan(-1);
      expect(collateralIdx).toBeGreaterThan(stormIdx); // after the storm block, not within it
      const between = restartBody.slice(stormIdx, collateralIdx);
      // The storm branch must be closed before the collateral emit begins.
      expect(between).toMatch(/\n {2}}\n/);
    });

    it('the freeze path snapshots collateral BEFORE issuing the restart', () => {
      // Reading the cgroup after `systemctl restart` returns nothing — the snapshot must precede it.
      const pollBody = src.slice(src.indexOf('async function poll('));
      const readIdx = pollBody.indexOf('await readCollateral(');
      const restartCallIdx = pollBody.indexOf('restart(\n');
      expect(readIdx).toBeGreaterThan(-1);
      expect(restartCallIdx).toBeGreaterThan(readIdx);
    });
  });

  describe('readCollateral — fail-soft on every fault (never breaks the restart path)', () => {
    const okShow = async () => ({ err: null, stdout: '/user.slice/app.slice/papercup-bg-host.service\n' });

    it('returns UNKNOWN(null) when systemctl cannot report the cgroup', async () => {
      expect(await readCollateral({ sh: async () => ({ err: new Error('boom'), stdout: '' }) })).toBeNull();
    });

    it('returns UNKNOWN(null) when the ControlGroup value is empty/nonsense', async () => {
      expect(await readCollateral({ sh: async () => ({ err: null, stdout: '\n' }) })).toBeNull();
    });

    it('returns UNKNOWN(null) when cgroup.procs is unreadable — never throws', async () => {
      const res = await readCollateral({
        sh: okShow,
        readFile: () => {
          throw new Error('EACCES');
        },
      });
      expect(res).toBeNull();
    });

    it('skips a pid that exits mid-scan instead of failing the whole snapshot', async () => {
      const res = await readCollateral({
        sh: okShow,
        readFile: (p: string) => {
          if (p.endsWith('cgroup.procs')) return '100\n200\n';
          if (p === '/proc/100/cmdline') return 'npm exec tsx /w/apps/operator/bin/spawner-sidecar.ts';
          throw new Error('ESRCH'); // 200 vanished between the two reads
        },
      });
      expect(res!.spawner).toBe(1);
      expect(res!.total).toBe(1);
    });

    it('converts NUL-separated /proc cmdline into readable text', async () => {
      const res = await readCollateral({
        sh: okShow,
        readFile: (p: string) => (p.endsWith('cgroup.procs') ? '100\n' : 'node\0/usr/lib/Papercusp GUI/serve.mjs\0'),
      });
      expect(res!.desktop).toBe(1);
    });
  });
});
