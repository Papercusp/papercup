// @vitest-environment jsdom
/**
 * AssignDialog — cross-user handoff / @-mention assign UI (P-008, Brief B8).
 * Roster + assign action are mocked at the plans-api boundary; the test drives
 * the picker (open via the nuqs `assign` key) → filter → select → assign, and
 * asserts assignToUser is called with the picked owner + plan/item refs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

const assignToUser = vi.fn(async (_args: unknown) => ({ ok: true, wake: { woken: 1 } }));
const useCoordRoster = vi.fn();

vi.mock('./plans-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plans-api')>();
  return { ...actual, useCoordRoster: () => useCoordRoster(), assignToUser: (a: unknown) => assignToUser(a) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AssignDialog from './AssignDialog';

const ROSTER = [
  { ownerId: 'fed:42@host', ownerLabel: 'alice', intent: 'on plan-x', federated: true, userId: '42', currentPlanSlug: null },
  { ownerId: 'su-bee-1', ownerLabel: 'bee-1', intent: 'building', federated: false, userId: null, currentPlanSlug: null },
];

function renderOpen(itemRef?: string) {
  const key = itemRef ? `item:p1:${itemRef}` : 'plan:p1';
  return render(<AssignDialog planSlug="p1" itemRef={itemRef ?? null} />, {
    wrapper: withNuqsTestingAdapter({ searchParams: `?assign=${encodeURIComponent(key)}` }),
  });
}

afterEach(() => {
  cleanup();
  assignToUser.mockClear();
  useCoordRoster.mockReset();
});

describe('AssignDialog (P-008)', () => {
  it('lists the roster (people first) and assigns the picked owner with plan ref + wake', async () => {
    useCoordRoster.mockReturnValue({ data: ROSTER, loading: false, error: null, refresh: () => {} });
    renderOpen();

    // Both members render; alice (federated person) is selectable.
    const alice = await screen.findByText('alice');
    expect(screen.getByText('bee-1')).toBeTruthy();

    fireEvent.click(alice); // select
    fireEvent.click(screen.getByText('Assign + notify'));

    await waitFor(() => expect(assignToUser).toHaveBeenCalledTimes(1));
    expect(assignToUser).toHaveBeenCalledWith({
      to: ['fed:42@host'],
      planSlug: 'p1',
      itemRef: null,
      note: null,
    });
  });

  it('the filter narrows the roster', async () => {
    useCoordRoster.mockReturnValue({ data: ROSTER, loading: false, error: null, refresh: () => {} });
    renderOpen();
    await screen.findByText('alice');
    fireEvent.change(screen.getByLabelText('Filter roster'), { target: { value: 'bee' } });
    expect(screen.queryByText('alice')).toBeNull();
    expect(screen.getByText('bee-1')).toBeTruthy();
  });

  it('per-item assign passes the item ref', async () => {
    useCoordRoster.mockReturnValue({ data: ROSTER, loading: false, error: null, refresh: () => {} });
    renderOpen('P-005');
    fireEvent.click(await screen.findByText('alice'));
    fireEvent.click(screen.getByText('Assign + notify'));
    await waitFor(() => expect(assignToUser).toHaveBeenCalledTimes(1));
    expect(assignToUser).toHaveBeenCalledWith({ to: ['fed:42@host'], planSlug: 'p1', itemRef: 'P-005', note: null });
  });

  it('Assign is disabled until a member is selected', async () => {
    useCoordRoster.mockReturnValue({ data: ROSTER, loading: false, error: null, refresh: () => {} });
    renderOpen();
    await screen.findByText('alice');
    expect((screen.getByText('Assign + notify') as HTMLButtonElement).disabled).toBe(true);
  });

  it('empty roster shows the no-one-online state', async () => {
    useCoordRoster.mockReturnValue({ data: [], loading: false, error: null, refresh: () => {} });
    renderOpen();
    expect(await screen.findByText('No one online to assign.')).toBeTruthy();
  });
});
