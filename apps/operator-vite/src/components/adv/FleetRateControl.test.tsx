// @vitest-environment jsdom
//
// FleetRateControl mount coverage — the /adv top-bar fleet rate/usage/max
// control (rate-limit-layer-v2-2026-06-05 P-013). The pure derivation layer
// (headlineUsagePct / fmtSpend / fmtAgents / pausedCount / parseMaxDraft) is
// pinned in __tests__/fleet-rate-control-logic.test.ts; THIS file mounts the
// component against a stubbed GET/PUT /api/operator/rate-limit-config (the
// sibling fetch-stub idiom — see AdvConversationsTab.test.tsx) and asserts the
// live numbers, the paused badge, the unreachable tooltip, and the edit→blur
// commit + Escape cancel flows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import FleetRateControl, { type FleetRateStatusWire } from './FleetRateControl';

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
