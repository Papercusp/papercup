/**
 * validate-declared-singletons — the boot guard for EI-10625.
 *
 * Its sibling `validateActiveRoutines` scans the routine rows that EXIST. A loop that was
 * never materialized has NO row, so it is structurally invisible to that check: you cannot
 * find a missing row by iterating the rows you have. This guard diffs against the
 * DECLARATION instead, which is the only way an absence is visible at all.
 *
 * These tests PROVE IT FIRES on the exact live shape (the memory recall canary: declared in
 * LEARNING_SINGLETONS, no routine row, 0 runs ever) — and that it stays quiet when every
 * declared loop is present, so it cannot become a boot-time cry-wolf.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  missing: [] as string[],
  entries: [] as unknown[],
}));

vi.mock('../blueprint/seed-learning-singletons', () => ({
  reconcileLearningSingletons: async () => ({
    entries: h.entries,
    missing: h.missing,
    healed: [],
  }),
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: (() => Promise.resolve([])) as unknown }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));

const { validateDeclaredSingletons } = await import('./validate-declared-singletons');

beforeEach(() => {
  h.missing = [];
  h.entries = [{}, {}];
});

describe('validateDeclaredSingletons', () => {
  it('FIRES: a declared loop with no routine row is reported and named', async () => {
    h.missing = ['memory-live-recall-canary'];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await validateDeclaredSingletons();

    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['memory-live-recall-canary']);
    // LOUD, and it names the loop — a guard that fires without saying what broke is a guard
    // nobody acts on.
    expect(err).toHaveBeenCalledWith(expect.stringContaining('memory-live-recall-canary'));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('never run'));
    err.mockRestore();
  });

  it('passes silently when every declared loop has its routine row', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await validateDeclaredSingletons();
    expect(r).toMatchObject({ ok: true, missing: [], checked: 2 });
    expect(err).not.toHaveBeenCalled(); // no cry-wolf on a healthy boot
    err.mockRestore();
  });
});
