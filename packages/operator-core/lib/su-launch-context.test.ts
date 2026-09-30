/**
 * Unit tests for the `psu` launch-context composer (su-launch-context.ts).
 * Pure function — no fs/route. Covers the four scope×plan quadrants and
 * the path helpers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { composeLaunchContext, launchContextDir, launchContextPathFor } from './su-launch-context';

describe('composeLaunchContext', () => {
  it('returns empty when neither harness nor plan is picked (ad-hoc launch)', () => {
    expect(composeLaunchContext({ harnessSlug: null, planSlug: null })).toBe('');
  });

  it('harness only → scoped block, no plan block', () => {
    const out = composeLaunchContext({ harnessSlug: 'papercup', planSlug: null });
    expect(out).toContain('harness `papercup`');
    // SU per-call model (P-004): the banner tells you to PASS the slug, not that it
    // is auto-scoped — and must NOT claim auto-scoping.
    expect(out).toContain("pass `harness: 'papercup'`");
    expect(out).toContain('cross_harness:docs_*');
    expect(out).not.toContain('**Plan:**');
    expect(out).toContain('papercusp-rule:test-router=test-file');
    expect(out).not.toContain('papercusp-rule:file-locking');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('Papercusp harness scope routes engineering docs to the canonical surface', () => {
    const out = composeLaunchContext({ harnessSlug: 'papercusp', planSlug: null });

    expect(out).toContain("pass `harness: 'papercusp'` to `features:*`, `issues:*`, and `plans:*`");
    expect(out).toContain("for `docs:*` reads of `agent-insights/*` and framework docs, pass `harness: 'all'`");
    expect(out).toContain("workspace-scoped sessions use `harness: 'engineering'` instead");
    expect(out).not.toContain("pass `harness: 'papercusp'` to `docs:*`");
  });

  it('distinguishes Vitest routing from registered non-Vitest test runners', () => {
    const out = composeLaunchContext({ harnessSlug: 'papercusp', planSlug: null });

    expect(out).toContain('Vitest files use `npm run test:file -- <test paths>`');
    expect(out).toContain('registered non-Vitest files');
    expect(out).toContain('`papercusp-desktop` Node tests');
    expect(out).toContain('`test:file` is Vitest-only');
  });

  it('no harness but a plan → workspace-level block + plan block', () => {
    const out = composeLaunchContext({ harnessSlug: null, planSlug: 'my-plan' });
    expect(out).toContain('workspace level');
    expect(out).toContain('bound to `my-plan`');
  });

  it('harness + plan + Now → renders Now/Next and the re-read nudge', () => {
    const out = composeLaunchContext({
      harnessSlug: 'papercup',
      planSlug: 'coord-port',
      planTitle: 'Coord PG port',
      planNow: { state: 'Phase 3 cutover live', next: 'verify round-trip' },
    });
    expect(out).toContain('harness `papercup`');
    expect(out).toContain('bound to `coord-port`');
    expect(out).toContain('— Coord PG port');
    expect(out).toContain('**Now:** Phase 3 cutover live');
    expect(out).toContain('**Next:** verify round-trip');
    expect(out).toContain('**First move:** read `coord-port`');
  });

  it('WI-10004449: a fleet LEADER is told to lead, never to claim the next item', () => {
    const leader = composeLaunchContext({ harnessSlug: 'papercusp', planSlug: 'p1', fleetRole: 'leader' });
    expect(leader).toContain("**First move:** you LEAD this plan's fleet");
    expect(leader).toContain("do not claim the plan's items yourself");
    expect(leader).not.toContain('claim its next actionable item');
    const member = composeLaunchContext({ harnessSlug: 'papercusp', planSlug: 'p1', fleetRole: 'member' });
    expect(member).toContain('claim its next actionable item');
  });

  it('plan without a readable Now → falls back to a plans:get nudge', () => {
    const out = composeLaunchContext({ harnessSlug: 'papercup', planSlug: 'p', planNow: null });
    expect(out).toContain('bound to `p`');
    expect(out).toContain("Read `plans:get { slug: 'p' }`");
    expect(out).not.toContain('**Now:**');
  });

  it('empty Now (both fields blank) is treated as no Now', () => {
    const out = composeLaunchContext({
      harnessSlug: 'papercup',
      planSlug: 'p',
      planNow: { state: '', next: '' },
    });
    expect(out).not.toContain('**Now:**');
    expect(out).toContain("Read `plans:get { slug: 'p' }`");
  });

  it('power/generic profiles omit Papercusp-repo-specific shortcuts', () => {
    const out = composeLaunchContext({
      harnessSlug: 'external',
      planSlug: null,
      profile: 'power',
    });
    expect(out).toContain('papercusp-rule:harness-scope=explicit-per-call');
    expect(out).not.toContain('papercusp-rule:test-router');
    expect(out).not.toContain('Tauri shell');
  });
});

describe('launch-context path helpers', () => {
  const saved = process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR;
    else process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = saved;
  });

  it('honors the PAPERCUSP_LAUNCH_CONTEXT_DIR override', () => {
    process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = '/tmp/lc';
    expect(launchContextDir()).toBe('/tmp/lc');
    expect(launchContextPathFor(42)).toBe('/tmp/lc/session-42.md');
  });

  it('defaults under ~/.papercusp when unset', () => {
    delete process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR;
    expect(launchContextDir()).toMatch(/\.papercusp\/launch-context$/);
    expect(launchContextPathFor('t-1')).toMatch(/\.papercusp\/launch-context\/session-t-1\.md$/);
  });
});
