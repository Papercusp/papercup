// @vitest-environment jsdom
//
// FleetRateControl coverage — the /adv top-bar fleet rate/usage/max control
// (rate-limit-layer-v2-2026-06-05 P-013). Two layers:
//   - the exported pure helpers (headlineUsagePct / fmtSpend / fmtAgents /
//     pausedCount / parseMaxDraft) — the display + commit-validation logic;
//   - the mounted component against a stubbed GET/PUT
//     /api/operator/rate-limit-config (the sibling fetch-stub idiom — see
//     AdvConversationsTab.test.tsx): live numbers, the paused badge, the
//     unreachable tooltip, and the edit→blur commit + Escape cancel flows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import FleetRateControl, {
  fmtAgents,
  fmtSpend,
  headlineUsagePct,
  parseMaxDraft,
  pausedCount,
  type FleetRateStatusWire,
} from './FleetRateControl';

function makeStatus(over: Partial<FleetRateStatusWire> = {}): FleetRateStatusWire {
  return {
    config: { maxSimultaneousAgents: 16, concurrencyFloor: 1 },
    fleet: { cap: 16, inFlight: 3, effective: 16, floor: 1 },
    buckets: [
      { key: 'anthropic', paused: false, pausedUntil: null },
      { key: 'openai', paused: false, pausedUntil: null },
    ],
    usage: {
      spendUsd: 1.23,
      calls: 42,
      buckets: [
        { key: 'anthropic', usagePct: 62 },
        { key: 'openai', usagePct: 12 },
        { key: 'sub', usagePct: null },
      ],
    },
    ...over,
  };
}

describe('FleetRateControl pure helpers', () => {
  it('headlineUsagePct picks the WORST known bucket and never fabricates', () => {
    expect(headlineUsagePct(undefined)).toBeNull();
    // subscription-only paths (all-null) → null, not 0
    expect(
      headlineUsagePct({ spendUsd: 0, calls: 0, buckets: [{ key: 'a', usagePct: null }] }),
    ).toBeNull();
    expect(headlineUsagePct(makeStatus().usage)).toBe(62);
  });

  it('fmtSpend is compact with sub-cent precision', () => {
    expect(fmtSpend(undefined)).toBe('$0');
    expect(fmtSpend(0)).toBe('$0');
    expect(fmtSpend(-1)).toBe('$0');
    expect(fmtSpend(0.005)).toBe('$0.0050');
    expect(fmtSpend(1.234)).toBe('$1.23');
  });

  it('fmtAgents omits the AIMD-effective slot when it equals the cap', () => {
    expect(fmtAgents(undefined)).toBe('—');
    expect(fmtAgents({ cap: 16, inFlight: 3, effective: 16, floor: 1 })).toBe('3 / 16');
    expect(fmtAgents({ cap: 16, inFlight: 3, effective: 6, floor: 1 })).toBe('3 / eff 6 / 16');
    // non-finite cap renders as ∞ (and eff falls back to cap)
    expect(fmtAgents({ cap: Infinity, inFlight: 3, effective: NaN, floor: 1 })).toBe('3 / ∞');
  });

  it('pausedCount counts only the currently-paused buckets', () => {
    expect(pausedCount(undefined)).toBe(0);
    expect(
      pausedCount([
        { key: 'a', paused: true, pausedUntil: null },
        { key: 'b', paused: false, pausedUntil: null },
        { key: 'c', paused: true, pausedUntil: null },
      ]),
    ).toBe(2);
  });

  it('parseMaxDraft accepts only integers within [1, ceiling]', () => {
    expect(parseMaxDraft('12')).toBe(12);
    expect(parseMaxDraft(' 8 ')).toBe(8);
    expect(parseMaxDraft('64')).toBe(64);
    expect(parseMaxDraft('0')).toBeNull();
    expect(parseMaxDraft('65')).toBeNull();
    expect(parseMaxDraft('3.5')).toBeNull();
    expect(parseMaxDraft('abc')).toBeNull();
    expect(parseMaxDraft('9', 8)).toBeNull(); // custom ceiling
  });
});

describe('FleetRateControl component', () => {
  let putBodies: Array<Record<string, unknown>>;

  function stubApi(status: FleetRateStatusWire | Error) {
    putBodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          putBodies.push(body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              config: { maxSimultaneousAgents: body.maxSimultaneousAgents, concurrencyFloor: 1 },
            }),
          };
        }
        if (status instanceof Error) throw status;
        return {
          ok: true,
          status: 200,
          json: async () => ({ config: status.config, status }),
        };
      }),
    );
  }

  beforeEach(() => {
    stubApi(makeStatus());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the live usage / spend / agents numbers and the max input', async () => {
    render(<FleetRateControl />);
    const input = await screen.findByLabelText<HTMLInputElement>('max agents');
    await waitFor(() => expect(input.value).toBe('16'));
    expect(screen.getByText('62%')).toBeTruthy();
    expect(screen.getByText('$1.23')).toBeTruthy();
    expect(screen.getByText('3 / 16')).toBeTruthy();
    expect(input.disabled).toBe(false);
    // no paused buckets → no badge
    expect(screen.queryByText(/paused/)).toBeNull();
  });

  it('shows the eff slot and the paused badge when the governor is throttling', async () => {
    stubApi(
      makeStatus({
        fleet: { cap: 16, inFlight: 4, effective: 6, floor: 1 },
        buckets: [
          { key: 'anthropic', paused: true, pausedUntil: null },
          { key: 'openai', paused: false, pausedUntil: null },
        ],
      }),
    );
    render(<FleetRateControl />);
    expect(await screen.findByText('4 / eff 6 / 16')).toBeTruthy();
    expect(screen.getByText('1 paused')).toBeTruthy();
  });

  it('degrades to placeholders + an unreachable tooltip when the API is down', async () => {
    stubApi(new Error('ECONNREFUSED'));
    render(<FleetRateControl />);
    await waitFor(() => expect(screen.getByTitle(/unreachable: ECONNREFUSED/)).toBeTruthy());
    expect(screen.getByText('—%')).toBeTruthy();
    expect(screen.getByText('$0')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('max agents').disabled).toBe(true);
  });

  it('commits an edited max on blur via PUT and adopts the saved config', async () => {
    render(<FleetRateControl />);
    const input = await screen.findByLabelText<HTMLInputElement>('max agents');
    await waitFor(() => expect(input.value).toBe('16'));

    act(() => input.focus());
    fireEvent.change(input, { target: { value: '24' } });
    expect(input.value).toBe('24');
    act(() => input.blur());

    await waitFor(() => expect(putBodies).toEqual([{ maxSimultaneousAgents: 24 }]));
    await waitFor(() => expect(input.value).toBe('24'));
  });

  it('does NOT PUT when the draft is invalid or unchanged', async () => {
    render(<FleetRateControl />);
    const input = await screen.findByLabelText<HTMLInputElement>('max agents');
    await waitFor(() => expect(input.value).toBe('16'));

    // invalid (over the 64 ceiling)
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '999' } });
    act(() => input.blur());
    // unchanged (same as the live value)
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '16' } });
    act(() => input.blur());

    await waitFor(() => expect(input.value).toBe('16'));
    expect(putBodies).toEqual([]);
  });

  it('Escape cancels the edit without committing the draft', async () => {
    render(<FleetRateControl />);
    const input = await screen.findByLabelText<HTMLInputElement>('max agents');
    await waitFor(() => expect(input.value).toBe('16'));

    act(() => input.focus());
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    // back to the live value, and no PUT fired
    await waitFor(() => expect(input.value).toBe('16'));
    expect(putBodies).toEqual([]);
  });
});
