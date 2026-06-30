/**
 * Unit tests for the `psu` launch-context composer (su-launch-context.ts).
 * Pure function — no fs/route. Covers the four scope×plan quadrants and
 * the path helpers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  composeLaunchContext,
  launchContextDir,
  launchContextPathFor,
} from './su-launch-context';

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
    expect(out).not.toContain("you don't pass its slug");
    expect(out).toContain('cross_harness:docs_*');
    expect(out).not.toContain('bound to plan');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('no harness but a plan → workspace-level block + plan block', () => {
    const out = composeLaunchContext({ harnessSlug: null, planSlug: 'my-plan' });
    expect(out).toContain('no harness scope');
    expect(out).toContain('relaunch via `psu`');
    expect(out).toContain('bound to plan `my-plan`');
  });

  it('harness + plan + Now → renders Now/Next and the re-read nudge', () => {
    const out = composeLaunchContext({
      harnessSlug: 'papercup',
      planSlug: 'coord-port',
      planTitle: 'Coord PG port',
      planNow: { state: 'Phase 3 cutover live', next: 'verify round-trip' },
    });
    expect(out).toContain('harness `papercup`');
    expect(out).toContain('bound to plan `coord-port`');
    expect(out).toContain('— Coord PG port');
    expect(out).toContain('> **Now:** Phase 3 cutover live');
    expect(out).toContain('> **Next:** verify round-trip');
    expect(out).toContain("plans:get { slug: 'coord-port' }");
    expect(out).toContain('plans:set-now');
  });

  it('plan without a readable Now → falls back to a plans:get nudge', () => {
    const out = composeLaunchContext({ harnessSlug: 'papercup', planSlug: 'p', planNow: null });
    expect(out).toContain('bound to plan `p`');
    expect(out).toContain("Read it with `plans:get { slug: 'p' }`");
    expect(out).not.toContain('> **Now:**');
  });

  it('empty Now (both fields blank) is treated as no Now', () => {
    const out = composeLaunchContext({
      harnessSlug: 'papercup',
      planSlug: 'p',
      planNow: { state: '', next: '' },
    });
    expect(out).not.toContain('> **Now:**');
    expect(out).toContain("Read it with `plans:get { slug: 'p' }`");
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
