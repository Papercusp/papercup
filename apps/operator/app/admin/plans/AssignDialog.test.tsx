// @vitest-environment jsdom
/**
 * AssignDialog — cross-user handoff / @-mention assign UI (P-008 + P-016).
 * Roster + assign action are mocked at the plans-api boundary; the test drives
 * the picker (open via the nuqs `assign` key) → filter → select → assign, and
 * asserts assignToUser is called with the picked member's assignAddress + refs —
 * a live ownerId for a present member, `@user:gh:<id>` for an OFFLINE member (the
 * P-016 park path).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

const assignToUser = vi.fn(async (_args: unknown) => ({ ok: true, wake: { woken: 1 } }));
const useAssignableMembers = vi.fn();

vi.mock('./plans-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plans-api')>();
  return {
    ...actual,
    useAssignableMembers: () => useAssignableMembers(),
    assignToUser: (a: unknown) => assignToUser(a),
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AssignDialog from './AssignDialog';

const ROSTER = [
  // An offline member is listed FIRST in the fixture to prove the dialog sorts
  // present-online members above offline ones regardless of input order.
  { assignAddress: '@user:gh:777', key: 'gh:777', label: 'bob', present: false, intent: null, userId: null, githubUsername: 'bobby' },
  { assignAddress: 'fed:42@host', key: 'fed:42@host', label: 'alice', present: true, intent: 'on plan-x', userId: '42', githubUsername: null },
  { assignAddress: 'su-bee-1', key: 'su-bee-1', label: 'bee-1', present: true, intent: 'building', userId: null, githubUsername: null },
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
  useAssignableMembers.mockReset();
});

describe('AssignDialog (P-008 + P-016)', () => {
  it('lists the roster and assigns a present member by their live ownerId + wake', async () => {
    useAssignableMembers.mockReturnValue({ data: ROSTER, loading: false, error: null, refresh: () => {} });
    renderOpen();

    // Online and offline members both render; the offline one is flagged.
    const alice = await screen.findByText('alice');
    expect(screen.getByText('bee-1')).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
    expect(screen.getByText('offline')).toBeTruthy();

    fireEvent.click(alice); // select a present member
    fireEvent.click(screen.getByText('Assign + notify'));

    await waitFor(() => expect(assignToUser).toHaveBeenCalledTimes(1));
    expect(assignToUser).toHaveBeenCalledWith({
      to: ['fed:42@host'],
      planSlug: 'p1',
      itemRef: null,
      note: null,
    });
  });

  it('assigns an OFFLINE member by their @user:gh:<id> park address (P-016)', async () => {
    useAssignableMembers.mockReturnValue({ data: ROSTER, loading: false, error: null, refresh: () => {} });
    renderOpen();
    fireEvent.click(await screen.findByText('bob'));
    fireEvent.click(screen.getByText('Assign + notify'));
    await waitFor(() => expect(assignToUser).toHaveBeenCalledTimes(1));
    expect(assignToUser).toHaveBeenCalledWith({
      to: ['@user:gh:777'],
      planSlug: 'p1',
      itemRef: null,
      note: null,
    });
  });

  it('the filter narrows the roster (incl. by github username)', async () => {
    useAssignableMembers.mockReturnValue({ data: ROSTER, loading: false, error: null, refresh: () => {} });
    renderOpen();
    await screen.findByText('alice');
    fireEvent.change(screen.getByLabelText('Filter roster'), { target: { value: 'bobby' } });
    expect(screen.queryByText('alice')).toBeNull();
    expect(screen.getByText('bob')).toBeTruthy();
  });

  it('per-item assign passes the item ref', async () => {
    useAssignableMembers.mockReturnValue({ data: ROSTER, loading: false, error: null, refresh: () => {} });
    renderOpen('P-005');
    fireEvent.click(await screen.findByText('alice'));
    fireEvent.click(screen.getByText('Assign + notify'));
    await waitFor(() => expect(assignToUser).toHaveBeenCalledTimes(1));
    expect(assignToUser).toHaveBeenCalledWith({ to: ['fed:42@host'], planSlug: 'p1', itemRef: 'P-005', note: null });
  });

  it('Assign is disabled until a member is selected', async () => {
    useAssignableMembers.mockReturnValue({ data: ROSTER, loading: false, error: null, refresh: () => {} });
    renderOpen();
    await screen.findByText('alice');
    expect((screen.getByText('Assign + notify') as HTMLButtonElement).disabled).toBe(true);
  });

  it('empty roster shows the no-members state', async () => {
    useAssignableMembers.mockReturnValue({ data: [], loading: false, error: null, refresh: () => {} });
    renderOpen();
    expect(await screen.findByText('No members to assign.')).toBeTruthy();
  });
});
