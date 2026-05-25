// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ClobberToast, type ClobberToastEvent } from '../ClobberToast';

afterEach(() => cleanup());

function ev(overrides: Partial<ClobberToastEvent> = {}): ClobberToastEvent {
  return {
    id: 'c1',
    table: 'queue',
    hbKey: '42/F-1',
    field: 'queued',
    byContributor: 'Alice',
    myValue: { removed_at: null },
    theirValue: { removed_at: 1700000000000 },
    observedAt: 1700000000000,
    ...overrides,
  };
}

describe('ClobberToast', () => {
  it('renders the override copy with table, hbKey, contributor', () => {
    render(<ClobberToast event={ev()} onDismiss={() => {}} />);
    const toast = screen.getByTestId('clobber-toast-c1');
    expect(toast.textContent).toContain('queued');
    expect(toast.textContent).toContain('42/F-1');
    expect(toast.textContent).toContain('Alice');
    expect(toast.textContent).toContain('was overridden by');
  });

  it('says "was overridden by", not "was rejected by" (per phase plan Q-2)', () => {
    render(<ClobberToast event={ev()} onDismiss={() => {}} />);
    expect(screen.getByTestId('clobber-toast-c1').textContent).not.toContain('rejected');
  });

  it('falls back to table tag when field is not provided', () => {
    render(<ClobberToast event={ev({ field: undefined })} onDismiss={() => {}} />);
    expect(screen.getByTestId('clobber-toast-c1').textContent).toContain('queue');
  });

  it('does NOT show the diff panel before "View diff" is clicked', () => {
    render(<ClobberToast event={ev()} onDismiss={() => {}} />);
    expect(screen.queryByTestId('clobber-diff-c1')).toBeFalsy();
  });

  it('expands the diff panel on "View diff" click', () => {
    render(<ClobberToast event={ev()} onDismiss={() => {}} />);
    const btn = screen.getByTestId('clobber-view-diff-c1');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('clobber-diff-c1')).toBeTruthy();
  });

  it('toggles back to collapsed on second click', () => {
    render(<ClobberToast event={ev()} onDismiss={() => {}} />);
    const btn = screen.getByTestId('clobber-view-diff-c1');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('clobber-diff-c1')).toBeFalsy();
  });

  it('renders both my-write and their-write JSON inside the diff panel', () => {
    render(<ClobberToast event={ev()} onDismiss={() => {}} />);
    fireEvent.click(screen.getByTestId('clobber-view-diff-c1'));
    const panel = screen.getByTestId('clobber-diff-c1');
    expect(panel.textContent).toContain('You wrote');
    expect(panel.textContent).toContain('Alice wrote');
    expect(panel.textContent).toContain('removed_at');
  });

  it('renders "—" when values are missing in the diff', () => {
    render(
      <ClobberToast
        event={ev({ myValue: undefined, theirValue: undefined })}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('clobber-view-diff-c1'));
    expect(screen.getByTestId('clobber-diff-c1').textContent).toContain('—');
  });

  it('fires onDismiss with the event id when × is clicked', () => {
    const onDismiss = vi.fn();
    render(<ClobberToast event={ev({ id: 'evt-99' })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('clobber-dismiss-evt-99'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('evt-99');
  });

  it('has role="status" for assistive-tech announcement', () => {
    render(<ClobberToast event={ev()} onDismiss={() => {}} />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('renders multiple toasts independently with stable testids', () => {
    render(
      <>
        <ClobberToast event={ev({ id: 'a' })} onDismiss={() => {}} />
        <ClobberToast event={ev({ id: 'b' })} onDismiss={() => {}} />
      </>,
    );
    expect(screen.getByTestId('clobber-toast-a')).toBeTruthy();
    expect(screen.getByTestId('clobber-toast-b')).toBeTruthy();
  });
});
