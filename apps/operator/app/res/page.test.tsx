// @vitest-environment jsdom
/**
 * page.test.tsx — /res board render coverage for the Agent-seats group
 * (agent-allocation-framework-2026-07-03 P-003).
 *
 * @papercusp/sync is mocked per-queryName fixture; the mutate hook is captured
 * so each seat interaction asserts the EXACT loopback body (the pinned P-001
 * agent_slot write contract: axis trio + top-level quantity, ref derived,
 * no sharePct). nuqs + sonner are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const FIXTURES: Record<string, unknown[]> = {};
const mutateCalls: unknown[] = [];
const mutateFn = vi.fn(async (args: unknown) => {
  mutateCalls.push(args);
  return { ok: true };
});

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => ({
    data: FIXTURES[queryName] ?? [],
    error: null,
  }),
  useSyncMutate: () => mutateFn,
}));

vi.mock('nuqs', () => ({
  useQueryState: () => ['', vi.fn()],
  parseAsString: { withDefault: () => ({}) },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import ResourcesPage from './page';

const SLOT_REF = 'opus[1m]:xhigh:AUTO';

beforeEach(() => {
  mutateCalls.length = 0;
  mutateFn.mockClear();
  FIXTURES['fleets.byWorkspace'] = [
    { workspaceId: 'ws-1', fleetSlug: 'fleet-a', title: 'Fleet A', owner: 'avi' },
  ];
  FIXTURES['accounts.pool'] = [
    { id: 'acct-1', label: 'Max #1' },
    { id: 'acct-2', label: 'API key' },
  ];
  FIXTURES['p2p.allotments'] = [
    { fleetSlug: 'fleet-a', resourceKind: 'account', resourceRef: 'acct-1', sharePct: 60, status: 'active' },
    {
      fleetSlug: 'fleet-a',
      resourceKind: 'agent_slot',
      resourceRef: SLOT_REF,
      sharePct: 0,
      quantity: 5,
      axis: { model: 'opus[1m]', effort: 'xhigh', account: 'AUTO' },
      status: 'active',
    },
    // Degraded pre-mig-486 slot row (no quantity/axis) — must be DROPPED, not crash.
    { fleetSlug: 'fleet-a', resourceKind: 'agent_slot', resourceRef: 'broken:row:X', sharePct: 0, status: 'active' },
  ];
  FIXTURES['agentConfig.modelTiersBaseline'] = [
    { name: 'quick', spec: 'haiku' },
    { name: 'deep', spec: 'opus[1m]:high' },
  ];
});

afterEach(() => cleanup());

describe('/res Agent-seats group (P-003)', () => {
  it('renders the two D-001 rail groups with helper ledes', () => {
    render(<ResourcesPage />);
    expect(screen.getByText('Autonomous-loop capacity')).toBeTruthy();
    expect(screen.getByText('Agent seats')).toBeTruthy();
    // one helper line per group
    expect(screen.getByText(/queen↔bee loop/)).toBeTruthy();
    expect(screen.getByText(/capped by/)).toBeTruthy();
  });

  it('seeds seat templates from the tier menu (bare spec → default effort; suffixed spec split)', () => {
    render(<ResourcesPage />);
    expect(screen.getByText('quick')).toBeTruthy();
    expect(screen.getByText('haiku·high')).toBeTruthy(); // DEFAULT_SEAT_EFFORT
    expect(screen.getByText('deep')).toBeTruthy();
    expect(screen.getByText('opus[1m]·high')).toBeTruthy();
    expect(screen.getAllByText('SEAT')).toHaveLength(2);
  });

  it("renders a slot chip 'N × model·effort' and drops the degraded row", () => {
    render(<ResourcesPage />);
    expect(screen.getByText('5 × opus[1m]·xhigh')).toBeTruthy();
    expect(screen.queryByText(/broken/)).toBeNull();
  });

  it('the chip account select offers AUTO + only the fleet-allocated accounts', () => {
    render(<ResourcesPage />);
    const select = screen.getByLabelText('opus[1m]·xhigh seats gateway account') as HTMLSelectElement;
    expect(select.value).toBe('AUTO');
    const opts = Array.from(select.options).map((o) => o.value);
    expect(opts).toEqual(['AUTO', 'acct-1']); // acct-2 is NOT allocated to fleet-a
  });

  it('stepper + upserts the same axis with quantity+1 (no sharePct)', () => {
    render(<ResourcesPage />);
    fireEvent.click(screen.getByLabelText('More opus[1m]·xhigh seats on Fleet A'));
    expect(mutateCalls[0]).toEqual({
      action: 'set',
      fleetSlug: 'fleet-a',
      resourceKind: 'agent_slot',
      resourceRef: SLOT_REF,
      quantity: 6,
      axis: { model: 'opus[1m]', effort: 'xhigh', account: 'AUTO' },
    });
  });

  it('stepper − decrements; the − button disables at quantity 1', () => {
    render(<ResourcesPage />);
    fireEvent.click(screen.getByLabelText('Fewer opus[1m]·xhigh seats on Fleet A'));
    expect((mutateCalls[0] as { quantity: number }).quantity).toBe(4);

    cleanup();
    (FIXTURES['p2p.allotments'] as Record<string, unknown>[])[1].quantity = 1;
    render(<ResourcesPage />);
    const minus = screen.getByLabelText('Fewer opus[1m]·xhigh seats on Fleet A') as HTMLButtonElement;
    expect(minus.disabled).toBe(true);
  });

  it('retargeting the account sets the NEW derived ref then removes the old row', async () => {
    render(<ResourcesPage />);
    const select = screen.getByLabelText('opus[1m]·xhigh seats gateway account');
    fireEvent.change(select, { target: { value: 'acct-1' } });
    await vi.waitFor(() => expect(mutateCalls).toHaveLength(2));
    expect(mutateCalls[0]).toEqual({
      action: 'set',
      fleetSlug: 'fleet-a',
      resourceKind: 'agent_slot',
      resourceRef: 'opus[1m]:xhigh:acct-1',
      quantity: 5,
      axis: { model: 'opus[1m]', effort: 'xhigh', account: 'acct-1' },
    });
    expect(mutateCalls[1]).toEqual({
      action: 'remove',
      fleetSlug: 'fleet-a',
      resourceKind: 'agent_slot',
      resourceRef: SLOT_REF,
    });
  });

  it('the chip × removes by the stored row ref', () => {
    render(<ResourcesPage />);
    fireEvent.click(screen.getByLabelText('Remove 5 × opus[1m]·xhigh seats from Fleet A'));
    expect(mutateCalls[0]).toEqual({
      action: 'remove',
      fleetSlug: 'fleet-a',
      resourceKind: 'agent_slot',
      resourceRef: SLOT_REF,
    });
  });

  it('account chips keep the %-slider path unchanged (regression guard)', () => {
    render(<ResourcesPage />);
    const slider = screen.getByLabelText('Max #1 share percent') as HTMLInputElement;
    expect(slider.value).toBe('60');
    fireEvent.pointerUp(slider);
    expect(mutateCalls[0]).toEqual({
      action: 'set',
      fleetSlug: 'fleet-a',
      resourceKind: 'account',
      resourceRef: 'acct-1',
      sharePct: 60,
    });
  });
});
