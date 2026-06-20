/**
 * harness/index.test.tsx — the retired /harness landing route, now a translating
 * redirect to /adv. Covers validateSearch (slug, the legacy ?project alias, and
 * the ?panel passthrough) and beforeLoad's PANEL_TO_TAB mapping → redirect: known
 * panels map to their /adv tab, unmapped/unknown panels fall back to harnesses,
 * and slug is carried only when present.
 *
 * Pure route options — no render. redirect is a tagged sentinel the route throws.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  redirect: (arg: Record<string, unknown>) => ({ __tag: 'redirect', ...arg }),
}));

import { Route } from './index';

const validateSearch = (Route as { validateSearch: (s: Record<string, unknown>) => { slug?: string; panel?: string } }).validateSearch;
const beforeLoad = (Route as { beforeLoad: (a: { search: { slug?: string; panel?: string } }) => void }).beforeLoad;

/** beforeLoad always throws the redirect sentinel; return what it threw. */
function redirectFor(search: { slug?: string; panel?: string }): { to: string; search: Record<string, unknown> } {
  try {
    beforeLoad({ search });
  } catch (e) {
    return e as { to: string; search: Record<string, unknown> };
  }
  throw new Error('expected beforeLoad to throw a redirect');
}

describe('/harness validateSearch', () => {
  it('keeps an explicit slug', () => {
    expect(validateSearch({ slug: 'alpha' })).toEqual({ slug: 'alpha', panel: undefined });
  });
  it('falls back to the legacy ?project alias for slug', () => {
    expect(validateSearch({ project: 'beta' })).toEqual({ slug: 'beta', panel: undefined });
  });
  it('prefers slug over project when both are present', () => {
    expect(validateSearch({ slug: 'alpha', project: 'beta' })).toEqual({ slug: 'alpha', panel: undefined });
  });
  it('passes panel through and drops non-string values', () => {
    expect(validateSearch({ panel: 'git' })).toEqual({ slug: undefined, panel: 'git' });
    expect(validateSearch({ slug: 1, project: 2, panel: 3 })).toEqual({ slug: undefined, panel: undefined });
  });
});

describe('/harness beforeLoad → /adv redirect', () => {
  it('maps a known panel to its /adv tab and carries the slug', () => {
    const r = redirectFor({ panel: 'git', slug: 'alpha' });
    expect(r.to).toBe('/adv');
    expect(r.search).toEqual({ tab: 'git', slug: 'alpha' });
  });
  it('maps the config panel to settings (config tab retired)', () => {
    expect(redirectFor({ panel: 'config' }).search).toEqual({ tab: 'settings' });
  });
  it('maps a no-tab panel (proposals) to the harnesses workspace', () => {
    expect(redirectFor({ panel: 'proposals' }).search).toEqual({ tab: 'harnesses' });
  });
  it('falls back to harnesses for an unknown panel', () => {
    expect(redirectFor({ panel: 'bogus' }).search).toEqual({ tab: 'harnesses' });
  });
  it('defaults to harnesses when no panel is given, omitting slug when absent', () => {
    expect(redirectFor({}).search).toEqual({ tab: 'harnesses' });
  });
  it('carries the slug under the default tab when only a slug is given', () => {
    expect(redirectFor({ slug: 'alpha' }).search).toEqual({ tab: 'harnesses', slug: 'alpha' });
  });
});
