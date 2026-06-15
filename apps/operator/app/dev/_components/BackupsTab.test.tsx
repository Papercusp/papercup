// @vitest-environment jsdom
//
// BackupsTab — wraps kopia's UI + a restore/promote flow. The tab body is an
// effect-only fetch + iframe shell; its pure display logic is the two metric
// formatters, fmtBytes (Number.isFinite-guarded, binary-prefix, variable
// precision: 2 decimals under 10, else 1) and fmtAgo (now-anchored relative
// age, null-safe). Both extracted + exported and pinned. The toast/dialog/grid/
// nuqs deps and the operator-core backup types are mocked so the module loads.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { confirmSpy } = vi.hoisted(() => ({ confirmSpy: vi.fn(async () => true) }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('nuqs', () => ({
  parseAsString: { withDefault: () => ({}) },
  useQueryState: () => ['', () => {}],
}));
vi.mock('@/app/harness/Select', () => ({ Select: () => null }));
// useConfirmDialog returns { confirm, element } — the mock MUST use those exact keys.
// An earlier mock used { askConfirm, confirmEl }, mirroring a real destructure bug in
// BackupsTab that left askConfirm undefined (restore/promote/rollback threw
// "askConfirm is not a function"). The regression test below clicks Rollback to pin it.
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmSpy, element: null }),
}));
vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));
vi.mock('@papercusp/operator-core/lib/backup', () => ({}));

import BackupsTab, { fmtBytes, fmtAgo } from './BackupsTab';

describe('fmtBytes', () => {
  it('returns "0 B" for zero, negative, and non-finite inputs', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(-5)).toBe('0 B');
    expect(fmtBytes(NaN)).toBe('0 B');
    expect(fmtBytes(Infinity)).toBe('0 B');
  });
  it('uses 2 decimals when the scaled value is under 10', () => {
    expect(fmtBytes(2 * 1024)).toBe('2.00 KB');
    expect(fmtBytes(1536)).toBe('1.50 KB');
  });
  it('uses 1 decimal when the scaled value is 10 or more', () => {
    expect(fmtBytes(20 * 1024)).toBe('20.0 KB');
  });
  it('climbs prefixes up to TB', () => {
    expect(fmtBytes(5 * 1024 ** 2)).toBe('5.00 MB');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(fmtBytes(2 * 1024 ** 4)).toBe('2.00 TB');
  });
  it('caps at TB rather than inventing a larger prefix', () => {
    expect(fmtBytes(5000 * 1024 ** 4)).toContain('TB');
  });
});

describe('fmtAgo', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z').getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('renders an em dash for null', () => {
    expect(fmtAgo(null)).toBe('—');
  });
  it('renders rounded s / m / h / d ages', () => {
    expect(fmtAgo(new Date(NOW - 30_000).toISOString())).toBe('30s');
    expect(fmtAgo(new Date(NOW - 90_000).toISOString())).toBe('2m'); // 1.5m rounds to 2
    expect(fmtAgo(new Date(NOW - 3 * 3_600_000).toISOString())).toBe('3h');
    expect(fmtAgo(new Date(NOW - 2 * 86_400_000).toISOString())).toBe('2d');
  });
});

describe('BackupsTab confirm-dialog wiring (regression — askConfirm must be callable)', () => {
  const okJson = (body: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);

  beforeEach(() => {
    confirmSpy.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/backups/snapshots')) return okJson({ snapshots: [] });
        if (url.startsWith('/api/backups/failures')) return okJson({ failures: [] });
        if (url.startsWith('/api/backups/healthcheck')) return okJson({ state: 'ok', kopia: { ok: true } });
        if (url.startsWith('/api/backups/events')) return okJson({ events: [] });
        if (url.startsWith('/api/backups/broken-list'))
          return okJson({ broken: [{ path: '/data/.broken-x', createdAt: '2026-06-15T00:00:00.000Z' }] });
        if (url.startsWith('/api/backups/server')) return okJson({ server: { port: 51515 } });
        if (url.startsWith('/api/backups/rollback')) return okJson({ result: { liveBefore: 'a', liveAfter: 'b' } });
        return okJson({ stats: null });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // The bug: BackupsTab destructured { askConfirm, confirmEl } from useConfirmDialog,
  // which actually returns { confirm, element } — so askConfirm was undefined and the
  // Rollback handler threw "askConfirm is not a function" (the dialog never showed).
  // esbuild type-strips dev/_components, so no build caught it. This renders the tab
  // with a broken-promotion dir, clicks Rollback, and asserts the confirm callback fired.
  it('clicking Rollback invokes the wired confirm dialog', async () => {
    render(<BackupsTab />);
    const btn = await screen.findByRole('button', { name: 'Rollback' });
    fireEvent.click(btn);
    await vi.waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toMatchObject({
      title: 'Rollback this promotion?',
      destructive: true,
    });
  });
});
