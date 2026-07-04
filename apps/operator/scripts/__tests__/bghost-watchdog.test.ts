import { describe, it, expect, beforeAll } from 'vitest';

// Don't let the watchdog's poll loop auto-start on import — exercise the pure decision logic only.
process.env.PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART = '1';

let parseIdleSec: (s: unknown) => number | null;
let isFrozen: (idleSec: number | null | undefined, freezeSilenceS?: number) => boolean;
let resolveDbUrl: (readFile?: (p: string, enc: string) => string) => string | null;
let shouldRestart: (idleSec: number | null, schedSec: number | null, freezeSilenceS?: number) => boolean;
let circuitOpenMessage: (
  reason: string,
  restartCount: number,
  cap: number,
  snapshot?: { cores: number; load1: number; loadPerCore: number; availableRatio: number; hasHeadroom: boolean } | null,
) => string;
beforeAll(async () => {
  ({ parseIdleSec, isFrozen, resolveDbUrl, shouldRestart, circuitOpenMessage } = await import('../bghost-watchdog.mjs'));
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
