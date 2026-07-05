/**
 * sessions.test.tsx — WI-3045 regression guard. The legacy `/adv/sessions`
 * route must redirect to a tab id that ACTUALLY EXISTS in AdvShell's
 * ADV_TABS — a stale id (the removed 'sessions' tab) silently falls back to
 * the 'overview' default (nuqs' parseAsStringEnum), which is exactly the bug
 * this pins: no error, just a surprising landing tab.
 *
 * Seam: @tanstack/react-router (createFileRoute → Route; redirect → the
 * thrown value), mirroring index.test.tsx's mock style.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  redirect: (opts: Record<string, unknown>) => ({ __redirect: true, ...opts }),
}));

import { Route } from './sessions';

describe('/adv/sessions legacy redirect (WI-3045)', () => {
  it('redirects to the Create dock (tab=plans) — the current home of the sessions view', () => {
    const beforeLoad = (Route as unknown as { beforeLoad: () => void }).beforeLoad;
    let thrown: unknown;
    try {
      beforeLoad();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toEqual({ __redirect: true, to: '/adv', search: { tab: 'plans' } });
  });

  it('never redirects to the removed "sessions" tab id', () => {
    const beforeLoad = (Route as unknown as { beforeLoad: () => void }).beforeLoad;
    let thrown: unknown;
    try {
      beforeLoad();
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { search?: { tab?: string } })?.search?.tab).not.toBe('sessions');
  });
});
