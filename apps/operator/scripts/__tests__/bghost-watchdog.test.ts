import { describe, it, expect, beforeAll } from 'vitest';

// Don't let the watchdog's poll loop auto-start on import — exercise the pure decision logic only.
process.env.PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART = '1';

let parseIdleSec: (s: unknown) => number | null;
let isFrozen: (idleSec: number | null | undefined, freezeSilenceS?: number) => boolean;
let resolveDbUrl: (readFile?: (p: string, enc: string) => string) => string | null;
beforeAll(async () => {
  ({ parseIdleSec, isFrozen, resolveDbUrl } = await import('../bghost-watchdog.mjs'));
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
});
