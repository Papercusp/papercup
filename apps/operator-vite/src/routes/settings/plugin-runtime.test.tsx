// @vitest-environment jsdom
/**
 * plugin-runtime.test.tsx — /settings/plugin-runtime diagnostics route. The
 * loader fetches /api/plugins/runtime/status (ok → status; !ok/throw → null);
 * the component renders <RuntimeView> on success or an error card when the
 * status is null. RuntimeView is stubbed.
 *
 * Seams: @tanstack/react-router (createFileRoute → Route exposing loader +
 * controllable useLoaderData), RuntimeView stubbed, fetch stubbed per-call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let loaderDataVal: { status: unknown };
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useLoaderData: () => loaderDataVal }),
}));
vi.mock('@/app/settings/plugin-runtime/RuntimeView', () => ({
  default: ({ status }: { status: { loaded: number } }) => (
    <div data-testid="runtime-view" data-loaded={status.loaded} />
  ),
}));

import { Route } from './plugin-runtime';

const loader = (Route as { loader: () => Promise<{ status: unknown }> }).loader;
const Comp = Route.component as () => JSX.Element;

let fetchImpl: () => { ok: boolean; body: unknown };
let fetchThrows = false;
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (fetchThrows) throw new Error('down');
    const r = fetchImpl();
    return { ok: r.ok, json: async () => r.body } as unknown as Response;
  }));
}

beforeEach(() => {
  fetchThrows = false;
  fetchImpl = () => ({ ok: true, body: { loaded: 3, errors: 0 } });
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/settings/plugin-runtime loader', () => {
  it('returns the parsed status when the endpoint is ok', async () => {
    const out = await loader();
    expect(out.status).toEqual({ loaded: 3, errors: 0 });
  });
  it('returns null status on a non-ok response', async () => {
    fetchImpl = () => ({ ok: false, body: {} });
    expect(await loader()).toEqual({ status: null });
  });
  it('returns null status when the fetch throws', async () => {
    fetchThrows = true;
    expect(await loader()).toEqual({ status: null });
  });
});

describe('/settings/plugin-runtime component', () => {
  it('renders RuntimeView when the status loaded', () => {
    loaderDataVal = { status: { loaded: 5 } };
    render(<Comp />);
    expect(screen.getByTestId('runtime-view').getAttribute('data-loaded')).toBe('5');
    expect(screen.queryByText(/Failed to read/)).toBeNull();
  });
  it('renders the error card when the status is null', () => {
    loaderDataVal = { status: null };
    render(<Comp />);
    expect(screen.getByText(/Failed to read/)).toBeTruthy();
    expect(screen.queryByTestId('runtime-view')).toBeNull();
  });
});
