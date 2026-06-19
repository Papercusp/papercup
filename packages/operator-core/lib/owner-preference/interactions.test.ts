/**
 * interactions.test.ts — fast unit regression for the queue-view throttle's
 * timestamp handling. The IO round-trip lives in interactions.integration.test.ts;
 * this isolates ONE thing the integration test structurally cannot catch:
 *
 *   The prod `getOrgPg()` driver returns `timestamptz` columns as STRINGS, but
 *   the integration-test pool auto-parses them to `Date` (same skew the file's
 *   jsonb note calls out, EI-607). `recordQueueExposure` typed the throttle row
 *   as `{ ts: Date }` and called `last[0].ts.getTime()` — which throws
 *   "ts.getTime is not a function" against the real string driver. The throw was
 *   swallowed by the fail-safe catch, so after the FIRST exposure row existed,
 *   every subsequent call crashed in the throttle check and recorded nothing —
 *   the model's exposure denominator silently flatlined (18+ hits/day in prod).
 *
 * These mock the driver to return a STRING ts (prod behavior) and assert the
 * throttle now works by logic, not by accident.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queries: [] as string[],
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      h.queries.push(q);
      if (/SELECT\s+ts/i.test(q)) return Promise.resolve(h.rows);
      return Promise.resolve([]); // INSERT and anything else
    },
  }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));

import { recordQueueExposure } from './interactions';

afterEach(() => {
  h.rows = [];
  h.queries = [];
  vi.restoreAllMocks();
});

describe('recordQueueExposure — prod returns timestamptz as a STRING (regression)', () => {
  it('records a new exposure when the prior string-ts row is OUTSIDE the throttle window', async () => {
    // ISO string, exactly what the real org-PG driver hands back (the test pool
    // would hand back a Date, which is why the integration test never caught this).
    h.rows = [{ ts: new Date(Date.now() - 11 * 60_000).toISOString() }]; // 11 min ago
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await recordQueueExposure(['EI-1', 'EI-2'], 'improvements');

    // Pre-fix: `'<string>'.getTime()` threw → swallowed → false, exposure lost.
    // Post-fix: coerced, window elapsed → it records and returns true.
    expect(result).toBe(true);
    expect(warn).not.toHaveBeenCalled(); // no swallowed crash
    expect(h.queries.some((q) => /INSERT INTO/i.test(q))).toBe(true); // actually recorded
  });

  it('still throttles a string-ts row that is INSIDE the window', async () => {
    h.rows = [{ ts: new Date(Date.now() - 30_000).toISOString() }]; // 30s ago
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await recordQueueExposure(['EI-1'], 'improvements');

    expect(result).toBe(false); // within 5-min window
    expect(warn).not.toHaveBeenCalled();
    expect(h.queries.some((q) => /INSERT INTO/i.test(q))).toBe(false); // nothing recorded
  });

  it('records the first-ever exposure (no prior row)', async () => {
    h.rows = []; // empty table
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await recordQueueExposure(['EI-1'], 'improvements');

    expect(result).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
