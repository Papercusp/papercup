// @vitest-environment jsdom
/**
 * PlanStatusPopover.test.tsx — the plan item status-flip popover + its item-id
 * resolver. Covers resolveItemId (data-plan-item attr, leading <strong>P/D-NNN,
 * the no-li / no-match nulls) and the popover: null render, the six status
 * buttons, current-status click → close (no write), a successful flip
 * (setItemStatus → onSuccess + onClose), the plain + busy error messages, and
 * Esc / outside-click close.
 *
 * Seam: ./plans-api setItemStatus stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let setStatusResult: unknown;
let setStatusThrows = false;
const setItemStatusMock = vi.fn(async () => {
  if (setStatusThrows) throw new Error('netfail');
  return setStatusResult;
});
vi.mock('./plans-api', () => ({ setItemStatus: (a: unknown) => setItemStatusMock(a as never) }));

import PlanStatusPopover, { resolveItemId, type PendingStatusFlip } from './PlanStatusPopover';

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('resolveItemId', () => {
  function codeInLi(inner: string, attrs: Record<string, string> = {}): HTMLElement {
    const li = document.createElement('li');
    Object.entries(attrs).forEach(([k, v]) => li.setAttribute(k, v));
    li.innerHTML = `${inner}<code data-plan-status>wip</code>`;
    document.body.appendChild(li);
    return li.querySelector('code')!;
  }

  it('returns null when the target is not inside an <li>', () => {
    const code = document.createElement('code');
    expect(resolveItemId(code)).toBeNull();
  });
  it('reads the data-plan-item attribute (read mode)', () => {
    expect(resolveItemId(codeInLi('', { 'data-plan-item': 'P-042' }))).toBe('P-042');
  });
  it('falls back to a leading <strong>P-NNN</strong> (edit mode)', () => {
    expect(resolveItemId(codeInLi('<strong>P-007</strong> title'))).toBe('P-007');
  });
  it('also matches a D-NNN decision id', () => {
    expect(resolveItemId(codeInLi('<strong>D-123</strong>'))).toBe('D-123');
  });
  it('returns null when the <strong> is not an item id', () => {
    expect(resolveItemId(codeInLi('<strong>Heading</strong>'))).toBeNull();
  });
});

describe('PlanStatusPopover', () => {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  function pendingFlip(status: PendingStatusFlip['status'] = 'todo'): PendingStatusFlip {
    const target = document.createElement('code');
    document.body.appendChild(target);
    return { target, status, itemId: 'P-001' };
  }
  function renderPopover(pending: PendingStatusFlip | null) {
    return render(<PlanStatusPopover pending={pending} slug="alpha" onSuccess={onSuccess} onClose={onClose} />);
  }

  beforeEach(() => { onSuccess.mockReset(); onClose.mockReset(); setItemStatusMock.mockReset(); setStatusThrows = false; setStatusResult = { ok: true }; });

  it('renders nothing when there is no pending flip', () => {
    const { container } = renderPopover(null);
    expect(container.firstChild).toBeNull();
  });

  it('renders the menu with the item id and six status choices', () => {
    renderPopover(pendingFlip());
    expect(screen.getByRole('menu', { name: /Set status for P-001/i })).toBeTruthy();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(6);
  });

  it('clicking the current status just closes (no write)', () => {
    renderPopover(pendingFlip('todo'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[0]); // todo = current
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(setItemStatusMock).not.toHaveBeenCalled();
  });

  it('flipping to a new status writes then calls onSuccess + onClose', async () => {
    setStatusResult = { ok: true };
    renderPopover(pendingFlip('todo'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[1]); // wip
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(setItemStatusMock).toHaveBeenCalledWith({ slug: 'alpha', itemId: 'P-001', status: 'wip' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the write error and does not close on a plain error', async () => {
    setStatusResult = { error: 'denied' };
    renderPopover(pendingFlip('todo'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[4]); // done
    expect(await screen.findByText('denied')).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('formats a busy lock error with owner + intent', async () => {
    setStatusResult = { error: 'busy', busy: [{ owner_label: 'shellX', intent: 'editing' }] };
    renderPopover(pendingFlip('todo'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[1]);
    expect(await screen.findByText(/busy: held by shellX \(editing\)/i)).toBeTruthy();
  });

  it('closes on Escape', () => {
    renderPopover(pendingFlip());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on an outside mousedown', () => {
    renderPopover(pendingFlip());
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
