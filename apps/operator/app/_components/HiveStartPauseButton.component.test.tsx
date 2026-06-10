// @vitest-environment jsdom
/**
 * HiveStartPauseButton (start-hive-wake-orchestration P-006) — the global
 * Start/Pause-Hive header control: hides without a hive, lexicon-resolved
 * label, the nuqs two-step confirm, and the run-tool bridge call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

let syncRows: unknown[] = [];
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: syncRows }),
}));
// Pin the lexicon to the classic pack so the label assertion is deterministic
// ("START POT"); the live binding is flag-reactive and covered by useLexicon's
// own tests.
vi.mock('@/lib/useLexicon', async (importOriginal) => {
  const { lexiconFor } = await import('@papercusp/lexicon');
  return { ...(await importOriginal<Record<string, unknown>>()), useLexicon: () => lexiconFor('classic') };
});

import { HiveStartPauseButton } from './HiveStartPauseButton';

const HIVE = { slug: 'my-hive', started: false, nextFireAt: null, lastWakeAt: null, watchdogFires24h: 0 };

beforeEach(() => {
  syncRows = [HIVE];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderBtn = (searchParams = '') =>
  render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <HiveStartPauseButton />
    </NuqsTestingAdapter>,
  );

describe('HiveStartPauseButton', () => {
  it('renders nothing when no hive is registered', () => {
    syncRows = [];
    renderBtn();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the lexicon-resolved verb for a paused hive and arms the confirm step on first click', () => {
    renderBtn();
    const btn = screen.getByRole('button', { name: 'Start Pot' });
    expect(btn.textContent).toContain('START POT');
    fireEvent.click(btn);
    expect(btn.textContent).toContain('Start?'); // confirm stage armed (nuqs)
  });

  it('shows Pause for a started hive', () => {
    syncRows = [{ ...HIVE, started: true }];
    renderBtn();
    expect(screen.getByRole('button', { name: 'Pause Pot' })).toBeTruthy();
  });

  it('confirm click POSTs the run-tool bridge with hive:start for a paused hive', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderBtn('?hiveCtl=confirm'); // deep-linked confirm stage — nuqs state
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/agent-mcp/run-tool');
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: 'hive:start',
      args: { harness: 'my-hive' },
      confirmed: true,
    });
  });
});
