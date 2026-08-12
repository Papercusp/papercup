// @vitest-environment jsdom
/**
 * KnowledgePackInstall.test.tsx — render + behaviour coverage for the Cupboard
 * in-place knowledge-pack install panel (cupboard-public-release-2026-07-12
 * P-016, "the Cupboard is the pack surface"). Exercises the four states that
 * matter: no pots, not-installed (Install offered), installed (mute/uninstall
 * management), and the core install → conflict-review → apply flow.
 *
 * useSyncQuery is mocked and switched on queryName (the panel drives THREE
 * reads: learning.hiveList, knowledgePacks.list, learning.hive). fetch is
 * stubbed per endpoint — the review flow returns `review_required` then applies
 * with resolutions, the same contract /api/knowledge-packs/install serves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncData: Record<string, unknown[]>;
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string }) => ({
    data: syncData[opts.queryName] ?? [],
    error: null,
    fetching: false,
    loading: false,
    invalidate: vi.fn(),
  }),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }));

import KnowledgePackInstall from './KnowledgePackInstall';

const listing = { id: 7, slug: 'coding', title: 'Coding' } as unknown as HarnessListing;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  syncData = { 'learning.hiveList': [], 'knowledgePacks.list': [], 'learning.hive': [] };
  toastSuccess.mockClear();
  toastError.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<KnowledgePackInstall /> (P-016)', () => {
  it('tells the user to make a pot first when there are none', () => {
    render(<KnowledgePackInstall listing={listing} />);
    expect(screen.queryByTestId('cupboard-kp-install-btn')).toBeNull();
    expect(screen.getByText(/No pot/i)).toBeTruthy();
  });

  it('offers Install into a pot when the pack is not installed there', () => {
    syncData['learning.hiveList'] = [{ slug: 'coding', remote: false }];
    render(<KnowledgePackInstall listing={listing} />);
    expect(screen.getByTestId('cupboard-kp-pot-select')).toBeTruthy();
    expect(screen.getByTestId('cupboard-kp-install-btn')).toBeTruthy();
    // No installed badge / manage row until it is actually in the pot.
    expect(screen.queryByTestId('cupboard-kp-installed-badge')).toBeNull();
    expect(screen.queryByTestId('cupboard-kp-manage')).toBeNull();
  });

  it('reflects installed state and offers mute + uninstall (upgrade only when available)', () => {
    syncData['learning.hiveList'] = [{ slug: 'coding', remote: false }];
    syncData['knowledgePacks.list'] = [
      { id: 'coding', title: 'Coding', description: '', version: '1.0.0', itemCount: 4, source: 'installed' },
    ];
    syncData['learning.hive'] = [
      { hive: 'coding', packs: [{ packId: 'coding', present: 4, modified: 0, notPresent: 0, packTotal: 4, enabled: true, updateAvailable: false }] },
    ];
    render(<KnowledgePackInstall listing={listing} />);
    expect(screen.getByTestId('cupboard-kp-installed-badge')).toBeTruthy();
    expect(screen.queryByTestId('cupboard-kp-install-btn')).toBeNull();
    expect(screen.getByTestId('cupboard-kp-mute')).toBeTruthy();
    expect(screen.getByTestId('cupboard-kp-uninstall')).toBeTruthy();
    // updateAvailable is false → no upgrade button.
    expect(screen.queryByTestId('cupboard-kp-upgrade')).toBeNull();
  });

  it('shows the upgrade action when a newer version is adoptable', () => {
    syncData['learning.hiveList'] = [{ slug: 'coding', remote: false }];
    syncData['knowledgePacks.list'] = [
      { id: 'coding', title: 'Coding', description: '', version: '2.0.0', itemCount: 4, source: 'installed' },
    ];
    syncData['learning.hive'] = [
      { hive: 'coding', packs: [{ packId: 'coding', present: 4, modified: 0, notPresent: 0, packTotal: 4, enabled: true, updateAvailable: true, availableVersion: '2.0.0' }] },
    ];
    render(<KnowledgePackInstall listing={listing} />);
    expect(screen.getByTestId('cupboard-kp-upgrade')).toBeTruthy();
  });

  it('two-step confirms an uninstall before firing it', () => {
    syncData['learning.hiveList'] = [{ slug: 'coding', remote: false }];
    syncData['knowledgePacks.list'] = [
      { id: 'coding', title: 'Coding', description: '', version: '1.0.0', itemCount: 4, source: 'installed' },
    ];
    syncData['learning.hive'] = [
      { hive: 'coding', packs: [{ packId: 'coding', present: 4, modified: 0, notPresent: 0, packTotal: 4, enabled: true }] },
    ];
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, removed: 4, kept: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<KnowledgePackInstall listing={listing} />);
    fireEvent.click(screen.getByTestId('cupboard-kp-uninstall'));
    // First click reveals the confirm button; it must NOT have fired the request.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('cupboard-kp-uninstall-confirm')).toBeTruthy();
  });

  it('installs into a pot: stage → conflict review → apply with resolutions', async () => {
    syncData['learning.hiveList'] = [{ slug: 'coding', remote: false }];
    // knowledgePacks.list empty ⇒ packId unknown until staged.
    const review = {
      packId: 'coding',
      packVersion: '1.0.0',
      clean: 1,
      duplicates: 0,
      conflicts: 1,
      present: 0,
      items: [
        {
          itemId: 'a',
          title: 'Rule A',
          incoming: 'always do A',
          status: 'conflict',
          existing: { id: 'x', text: 'never do A', organic: true, score: 0.82 },
          summary: 'contradicts an existing learning',
          defaultAction: 'skip',
        },
        { itemId: 'b', title: 'Rule B', incoming: 'do B', status: 'clean', defaultAction: 'install' },
      ],
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, opts?: { body?: string }) => {
      const body = opts?.body ? (JSON.parse(opts.body) as Record<string, unknown>) : {};
      calls.push({ url: String(url), body });
      if (String(url).endsWith('/fetch-from-comb')) {
        return jsonResponse({ ok: true, pack: { id: 'coding', title: 'Coding', version: '1.0.0', itemCount: 2 } });
      }
      if (String(url).endsWith('/install')) {
        if (body.resolutions) {
          return jsonResponse({ ok: true, packId: 'coding', packVersion: '1.0.0', installed: 1, skipped: 1, replaced: 0, failed: 0 });
        }
        return jsonResponse({ ok: false, reason: 'review_required', review });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<KnowledgePackInstall listing={listing} />);
    fireEvent.click(screen.getByTestId('cupboard-kp-install-btn'));

    // The review surfaces, showing the ONE clash (the clean item is auto-added).
    const reviewEl = await screen.findByTestId('cupboard-kp-review');
    expect(reviewEl).toBeTruthy();
    expect(screen.getByText('Rule A')).toBeTruthy();
    expect(screen.queryByText('Rule B')).toBeNull();

    // Apply → the second install POST carries a resolution for the clash.
    fireEvent.click(screen.getByTestId('cupboard-kp-apply'));
    await screen.findByTestId('cupboard-kp-result');

    const installCalls = calls.filter((c) => c.url.endsWith('/install'));
    expect(installCalls).toHaveLength(2);
    expect(installCalls[0].body.resolutions).toBeUndefined();
    expect(installCalls[1].body.resolutions).toEqual([{ itemId: 'a', action: 'skip' }]);
    expect(toastSuccess).toHaveBeenCalled();
  });
});
