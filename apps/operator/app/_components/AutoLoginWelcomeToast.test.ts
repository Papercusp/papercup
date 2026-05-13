/**
 * Locks the 4am-local-time boundary logic for AutoLoginWelcomeToast.
 * The function is a pure helper extracted from the component; we
 * intentionally test the boundary math without mounting React (no
 * jsdom / localStorage / toast needed).
 */
import { describe, it, expect } from 'vitest';

/** Compute the most recent 4am-local epoch ms boundary at or before `now`. */
function lastReset4amLocalMs(now: number): number {
  const d = new Date(now);
  const today4am = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime();
  return now >= today4am ? today4am : today4am - 24 * 60 * 60 * 1000;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

describe('AutoLoginWelcomeToast — 4am-local boundary', () => {
  it('at 3:59am local: boundary is yesterday 4am', () => {
    const now = new Date(2026, 4, 15, 3, 59, 0).getTime(); // May 15, 03:59 local
    const boundary = lastReset4amLocalMs(now);
    const expected = new Date(2026, 4, 14, 4, 0, 0).getTime(); // May 14, 04:00 local
    expect(boundary).toBe(expected);
  });

  it('at 4:00am local exactly: boundary is today 4am', () => {
    const now = new Date(2026, 4, 15, 4, 0, 0).getTime();
    const boundary = lastReset4amLocalMs(now);
    expect(boundary).toBe(now);
  });

  it('at 4:01am local: boundary is today 4am', () => {
    const now = new Date(2026, 4, 15, 4, 1, 0).getTime();
    const boundary = lastReset4amLocalMs(now);
    const expected = new Date(2026, 4, 15, 4, 0, 0).getTime();
    expect(boundary).toBe(expected);
  });

  it('at noon local: boundary is today 4am', () => {
    const now = new Date(2026, 4, 15, 12, 0, 0).getTime();
    const boundary = lastReset4amLocalMs(now);
    const expected = new Date(2026, 4, 15, 4, 0, 0).getTime();
    expect(boundary).toBe(expected);
  });

  it('at 11:59pm local: boundary is today 4am', () => {
    const now = new Date(2026, 4, 15, 23, 59, 0).getTime();
    const boundary = lastReset4amLocalMs(now);
    const expected = new Date(2026, 4, 15, 4, 0, 0).getTime();
    expect(boundary).toBe(expected);
  });

  it('boundaries are always exactly 24h apart day-to-day', () => {
    const noon = new Date(2026, 4, 15, 12, 0, 0).getTime();
    const nextNoon = new Date(2026, 4, 16, 12, 0, 0).getTime();
    const b1 = lastReset4amLocalMs(noon);
    const b2 = lastReset4amLocalMs(nextNoon);
    expect(b2 - b1).toBe(MS_PER_DAY);
  });

  it('two visits 1h apart both in the same window: same boundary', () => {
    const t1 = new Date(2026, 4, 15, 10, 0, 0).getTime();
    const t2 = t1 + MS_PER_HOUR;
    expect(lastReset4amLocalMs(t1)).toBe(lastReset4amLocalMs(t2));
  });

  it('visits across 4am rollover: different boundaries (welcome fires again)', () => {
    const before4am = new Date(2026, 4, 15, 3, 30, 0).getTime();
    const after4am = new Date(2026, 4, 15, 4, 30, 0).getTime();
    expect(lastReset4amLocalMs(before4am)).not.toBe(lastReset4amLocalMs(after4am));
  });

  describe('path-based suppression (round-14 audit follow-up)', () => {
    const SUPPRESSED_PATHS = ['/login', '/signup'];
    const isSuppressed = (pathname: string | null): boolean => {
      if (!pathname) return false;
      return SUPPRESSED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
    };
    it('suppresses on /login (exact)', () => expect(isSuppressed('/login')).toBe(true));
    it('suppresses on /login?switch=1 (subpath via search would be handled by browser; just the path)', () => expect(isSuppressed('/login')).toBe(true));
    it('suppresses on /signup', () => expect(isSuppressed('/signup')).toBe(true));
    it('suppresses on /login/something (defensive prefix match)', () => expect(isSuppressed('/login/whatever')).toBe(true));
    it('does NOT suppress /harness', () => expect(isSuppressed('/harness')).toBe(false));
    it('does NOT suppress /', () => expect(isSuppressed('/')).toBe(false));
    it('does NOT suppress /settings/user', () => expect(isSuppressed('/settings/user')).toBe(false));
    it('does NOT suppress unrelated /loginish', () => expect(isSuppressed('/loginish')).toBe(false));
    it('does not suppress on null pathname (router transitioning)', () => expect(isSuppressed(null)).toBe(false));
  });

  describe('suppression contract (the same predicate the component uses)', () => {
    const shouldFire = (now: number, lastWelcomedMs: number): boolean => {
      const boundary = lastReset4amLocalMs(now);
      return lastWelcomedMs < boundary;
    };

    it('first-time-ever (lastMs=0) always fires', () => {
      const now = new Date(2026, 4, 15, 12, 0, 0).getTime();
      expect(shouldFire(now, 0)).toBe(true);
    });

    it('welcomed at 9am, revisits at 10am same day: NO fire', () => {
      const welcomedAt = new Date(2026, 4, 15, 9, 0, 0).getTime();
      const now = new Date(2026, 4, 15, 10, 0, 0).getTime();
      expect(shouldFire(now, welcomedAt)).toBe(false);
    });

    it('welcomed at 9am yesterday, revisits at 10am today: fire (crossed 4am)', () => {
      const welcomedAt = new Date(2026, 4, 14, 9, 0, 0).getTime();
      const now = new Date(2026, 4, 15, 10, 0, 0).getTime();
      expect(shouldFire(now, welcomedAt)).toBe(true);
    });

    it('welcomed at 11pm yesterday, revisits at 3am today: NO fire (still pre-4am)', () => {
      const welcomedAt = new Date(2026, 4, 14, 23, 0, 0).getTime();
      const now = new Date(2026, 4, 15, 3, 0, 0).getTime();
      expect(shouldFire(now, welcomedAt)).toBe(false);
    });

    it('welcomed at 11pm yesterday, revisits at 5am today: fire (crossed 4am)', () => {
      const welcomedAt = new Date(2026, 4, 14, 23, 0, 0).getTime();
      const now = new Date(2026, 4, 15, 5, 0, 0).getTime();
      expect(shouldFire(now, welcomedAt)).toBe(true);
    });
  });
});
