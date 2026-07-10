// @vitest-environment jsdom
/**
 * $slug/index.test.tsx — the /harness/$slug route's data layer + component.
 * Covers the documented ?dock drift guard (validateSearch normalizes 1 and '1'
 * → 1, everything else → undefined), loaderDeps threading, the loader's
 * retry-then-notFound / redirect-to-/adv / happy paths (backoff stubbed
 * instant), and the component's dock-shell-vs-Navigate branch.
 *
 * Seams: @tanstack/react-router (createFileRoute → Route exposing the route
 * options + controllable useLoaderData/useSearch; notFound/redirect → tagged
 * sentinels; Navigate → marker), HarnessDockShell + InsightsFirstVisitGate
 * stubbed, fetch + setTimeout stubbed per-test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let loaderDataVal: { project: { slug: string; path?: string } };
let searchVal: { dock?: number };
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useLoaderData: () => loaderDataVal,
    useSearch: () => searchVal,
  }),
  notFound: () => ({ __tag: 'notFound' }),
  redirect: (arg: Record<string, unknown>) => ({ __tag: 'redirect', ...arg }),
  Navigate: (props: { to: string; search?: unknown }) => (
    <div data-testid="navigate" data-to={props.to} data-search={JSON.stringify(props.search)} />
  ),
}));
vi.mock('@/app/harness/[slug]/HarnessDockShell', () => ({
  default: ({ slug }: { slug: string }) => <div data-testid="dock-shell" data-slug={slug} />,
}));
vi.mock('@/app/harness/insights/InsightsFirstVisitGate', () => ({
  InsightsFirstVisitGate: ({ slug }: { slug: string }) => <div data-testid="first-visit" data-slug={slug} />,
}));

import { Route } from './index';

const validateSearch = (Route as { validateSearch: (s: Record<string, unknown>) => { dock?: number } }).validateSearch;
const loaderDeps = (Route as { loaderDeps: (a: { search: { dock?: number } }) => { dock?: number } }).loaderDeps;
const loader = (Route as { loader: (a: { params: { slug: string }; deps: { dock?: number } }) => Promise<{ project: { slug: string } }> }).loader;
const Comp = Route.component as () => JSX.Element;

let fetchImpl: () => { ok: boolean; body: unknown };
let fetchCount = 0;
function stubFetch() {
  fetchCount = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCount++;
    const r = fetchImpl();
    return { ok: r.ok, json: async () => r.body } as unknown as Response;
  }));
}
/** Make the loader's retry backoff resolve synchronously. */
function instantTimers() {
  vi.stubGlobal('setTimeout', ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
}

beforeEach(() => {
  fetchImpl = () => ({ ok: true, body: { projects: [{ slug: 'alpha', path: '/a' }] } });
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/harness/$slug validateSearch (?dock guard)', () => {
  it('normalizes the number 1 to { dock: 1 }', () => {
    expect(validateSearch({ dock: 1 })).toEqual({ dock: 1 });
  });
  it("self-heals a stringified '1' back to { dock: 1 }", () => {
    expect(validateSearch({ dock: '1' })).toEqual({ dock: 1 });
  });
  it('maps every other dock value to undefined', () => {
    expect(validateSearch({})).toEqual({ dock: undefined });
    expect(validateSearch({ dock: 0 })).toEqual({ dock: undefined });
    expect(validateSearch({ dock: '2' })).toEqual({ dock: undefined });
    expect(validateSearch({ dock: 'true' })).toEqual({ dock: undefined });
  });
});

describe('/harness/$slug loaderDeps', () => {
  it('threads the dock dep through to the loader', () => {
    expect(loaderDeps({ search: { dock: 1 } })).toEqual({ dock: 1 });
    expect(loaderDeps({ search: {} })).toEqual({ dock: undefined });
  });
});

describe('/harness/$slug loader', () => {
  it('returns the matched project on the opt-in dock path', async () => {
    const out = await loader({ params: { slug: 'alpha' }, deps: { dock: 1 } });
    expect(out.project.slug).toBe('alpha');
    expect(fetchCount).toBe(1);
  });

  it('redirects to /adv when the dock is not opted in', async () => {
    await expect(loader({ params: { slug: 'alpha' }, deps: { dock: undefined } }))
      .rejects.toMatchObject({ __tag: 'redirect', to: '/adv', search: { tab: 'harnesses', slug: 'alpha' } });
  });

  it('throws notFound after 3 tries when the slug is unknown', async () => {
    instantTimers();
    await expect(loader({ params: { slug: 'ghost' }, deps: { dock: 1 } }))
      .rejects.toMatchObject({ __tag: 'notFound' });
    expect(fetchCount).toBe(3);
  });

  it('throws notFound after 3 tries when the endpoint keeps erroring', async () => {
    instantTimers();
    fetchImpl = () => ({ ok: false, body: {} });
    await expect(loader({ params: { slug: 'alpha' }, deps: { dock: 1 } }))
      .rejects.toMatchObject({ __tag: 'notFound' });
    expect(fetchCount).toBe(3);
  });

  it('recovers through a transient fetch rejection on the first try', async () => {
    instantTimers();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      if (n === 1) throw new Error('flaky');
      return { ok: true, json: async () => ({ projects: [{ slug: 'alpha', path: '/a' }] }) } as unknown as Response;
    }));
    const out = await loader({ params: { slug: 'alpha' }, deps: { dock: 1 } });
    expect(out.project.slug).toBe('alpha');
    expect(n).toBe(2);
  });
});

describe('/harness/$slug component', () => {
  it('renders the first-visit gate + dock shell when ?dock=1', () => {
    searchVal = { dock: 1 };
    loaderDataVal = { project: { slug: 'alpha' } };
    render(<Comp />);
    expect(screen.getByTestId('first-visit').getAttribute('data-slug')).toBe('alpha');
    expect(screen.getByTestId('dock-shell').getAttribute('data-slug')).toBe('alpha');
    expect(screen.queryByTestId('navigate')).toBeNull();
  });

  it('renders the /adv Navigate safety-net when dock is not 1', () => {
    searchVal = { dock: undefined };
    loaderDataVal = { project: { slug: 'beta' } };
    render(<Comp />);
    expect(screen.getByTestId('navigate').getAttribute('data-to')).toBe('/adv');
    expect(screen.queryByTestId('dock-shell')).toBeNull();
  });
});
