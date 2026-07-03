import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Regression guard: a POST-MERGE install must NEVER (re)create the legacy
 * `papercup` harness. Owner-directed 2026-07-03 ("there should be NO papercup
 * harness at all; it must be completely deletable from the system AND the
 * install process") after the Mac VM purge proved papercup was pure leftover
 * from the INCOMPLETE papercup→papercusp rename (plan
 * papercup-to-papercusp-migration-2026-06-20 — Phase-6 removal of the old Pot
 * was owner-gated and never ran, so papercup lingered on pre-merge installs).
 *
 * `registerPapercupHarness` is the ONLY code that ever creates a `papercup`
 * project row (called solely by the manual run-dogfood-bootstrap.ts dev
 * script — NOT by any live boot path; host-bootstrap.ts boots via
 * startBootstrapPapercuspHive()). Its B-merge skip guard is what keeps a
 * post-merge boot from re-minting papercup. That guard previously had ZERO
 * coverage — this file locks it in so the merge can't silently regress and
 * resurrect papercup on the next from-source install.
 *
 * All external deps are mocked (hoisted registry state) so this is a pure,
 * fast unit test of the guard's control flow — no PG, no real registry.
 */

const REPO = '/repo/papercusp';
const PAPERCUP = 'papercup';

interface Project {
  slug: string;
  path: string;
  harness_kind?: string;
}

const h = vi.hoisted(() => ({
  state: {
    projects: [] as Project[],
    saved: [] as Array<{ projects: Project[] }>,
  },
}));

vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: h.state.projects })),
  saveHarnessRegistry: vi.fn(async (reg: { projects: Project[] }) => {
    h.state.saved.push(reg);
  }),
}));

vi.mock('./papercusp-workspace', () => ({
  PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
  ensurePapercuspWorkspace: vi.fn(() => ({ id: 'papercusp-workspace' })),
}));

vi.mock('../workspace-registry', () => ({
  readRegistry: vi.fn(() => ({ workspaces: [{ id: 'papercusp-workspace' }] })),
}));

import { registerPapercupHarness } from './register-papercusp';

beforeEach(() => {
  h.state.projects = [];
  h.state.saved = [];
});

describe('registerPapercupHarness — B-merge skip guard (papercup must never be re-created post-merge)', () => {
  it('SKIPS (never creates papercup) when the merged papercusp hive owns the repo root', async () => {
    // The post-merge steady state: `papercusp` is the merged hive that IS this
    // repo. registration must decline to also mint a legacy `papercup` Pot.
    h.state.projects = [{ slug: 'papercusp', path: REPO, harness_kind: 'hive' }];

    const res = await registerPapercupHarness({ pathOverride: REPO });

    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/merged hive/i);
    expect(res.reason).toContain('papercusp');
    // Crucially: NO write happened — papercup was never pushed.
    expect(h.state.saved).toHaveLength(0);
    expect(h.state.projects.some((p) => p.slug === PAPERCUP)).toBe(false);
  });

  it('does NOT re-add papercup when a papercup entry somehow already exists (idempotent, no duplicate)', async () => {
    h.state.projects = [{ slug: PAPERCUP, path: REPO }];

    const res = await registerPapercupHarness({ pathOverride: REPO });

    expect(res.state).toBe('already-registered');
    // No new write, no duplicate.
    expect(h.state.saved).toHaveLength(0);
    expect(h.state.projects.filter((p) => p.slug === PAPERCUP)).toHaveLength(1);
  });

  it('the merged-hive guard beats the empty-registry create path (regression: the guard, not chance, prevents creation)', async () => {
    // Sanity anchor for the guard: WITHOUT any merged hive AND without an
    // existing papercup, the legacy path WOULD create papercup (this is the
    // pre-merge behavior the guard exists to suppress once the hive lands).
    // Proving this path is live makes the skip in the test above meaningful —
    // it's the guard doing the work, not an inert code path.
    h.state.projects = [];

    const res = await registerPapercupHarness({ pathOverride: REPO });

    expect(res.state).toBe('newly-registered');
    expect(h.state.saved).toHaveLength(1);
    expect(h.state.saved[0].projects.some((p) => p.slug === PAPERCUP)).toBe(true);
  });
});
