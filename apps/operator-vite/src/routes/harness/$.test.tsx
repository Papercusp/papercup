/**
 * harness/$.test.tsx — the retired per-slug dashboard routes, now a translating
 * splat redirect to /adv (design-simplification-2026-07-09 P-008). Covers the
 * splat parse (slug + sub-path) and the sub-path → /adv tab translation.
 *
 * Pure route options — no render. redirect is a tagged sentinel the route throws.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  redirect: (arg: Record<string, unknown>) => ({ __tag: 'redirect', ...arg }),
}));

import { Route } from './$';

const beforeLoad = (Route as { beforeLoad: (a: { params: { _splat?: string } }) => void }).beforeLoad;

/** beforeLoad always throws the redirect sentinel; return what it threw. */
function redirectFor(splat: string | undefined): { to: string; search: Record<string, unknown> } {
  try {
    beforeLoad({ params: { _splat: splat } });
  } catch (e) {
    return e as { to: string; search: Record<string, unknown> };
  }
  throw new Error('expected beforeLoad to throw a redirect');
}

describe('/harness/$ beforeLoad → /adv redirect', () => {
  it('sends a bare slug to the harnesses workspace with the slug selected', () => {
    const r = redirectFor('alpha');
    expect(r.to).toBe('/adv');
    expect(r.search).toEqual({ tab: 'harnesses', slug: 'alpha' });
  });
  it('translates the insights sub-path to the insights tab', () => {
    expect(redirectFor('alpha/insights').search).toEqual({ tab: 'insights', slug: 'alpha' });
  });
  it('lands projects pages on the harnesses workspace (no /adv parity)', () => {
    expect(redirectFor('alpha/projects').search).toEqual({ tab: 'harnesses', slug: 'alpha' });
    expect(redirectFor('alpha/projects/42').search).toEqual({ tab: 'harnesses', slug: 'alpha' });
  });
  it('falls back to harnesses for an unknown sub-path', () => {
    expect(redirectFor('alpha/dock-preview').search).toEqual({ tab: 'harnesses', slug: 'alpha' });
  });
  it('handles an empty splat without a slug', () => {
    expect(redirectFor(undefined).search).toEqual({ tab: 'harnesses' });
    expect(redirectFor('').search).toEqual({ tab: 'harnesses' });
  });
});
