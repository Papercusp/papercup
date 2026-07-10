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
  deps?: { dbUrl?: string | null; sh?: (cmd: string, args: string[]) => Promise<{ err: Error | null; stdout: string }>; log?: (m: string) => void },
) => Promise<boolean>;
let circuitOpenMessage: (
  reason: string,
  restartCount: number,
  cap: number,
  snapshot?: { cores: number; load1: number; loadPerCore: number; availableRatio: number; hasHeadroom: boolean } | null,
) => string;
beforeAll(async () => {
  ({ parseIdleSec, isFrozen, resolveDbUrl, shouldRestart, withinBootGrace, nextDebounceMs, shouldAlert, alertFleet, circuitOpenMessage } =
    await import('../bghost-watchdog.mjs'));
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
    it('inserts into coord_event_log via psql -v bind-variables (never raw string interpolation)', async () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const sh = async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { err: null, stdout: '' };
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
      const sqlArg = calls[0].args[calls[0].args.length - 1];
      expect(sqlArg).toContain('harness_shared.coord_event_log');
      expect(sqlArg).not.toContain('test alert body'); // never raw-interpolated into the SQL text itself
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
