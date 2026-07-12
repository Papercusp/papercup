// @vitest-environment jsdom
/**
 * picker-kit — the shared Create⇄Conversations vocabulary (picker-kit.tsx).
 *
 * Covers: EmptyState (title/desc/icon/action), Pill (active style+attr,
 * onClick, accent override), ErrorBanner (role="alert"), friendlyApiError
 * (code mapping + raw fallback), and useDebouncedValue (initial then debounced
 * value under fake timers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, act } from '@testing-library/react';
import { EmptyState, Pill, pillStyle, ErrorBanner, friendlyApiError, useDebouncedValue, DEBOUNCE_MS } from './picker-kit';

afterEach(() => cleanup());

describe('EmptyState', () => {
  it('renders title, desc, icon, and action', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={<svg data-testid="empty-icon" />}
        title="No conversations yet"
        desc="Start one to see it here."
        action={<button onClick={onClick}>Create</button>}
      />,
    );
    expect(screen.getByText('No conversations yet')).toBeTruthy();
    expect(screen.getByText('Start one to see it here.')).toBeTruthy();
    expect(screen.getByTestId('empty-icon')).toBeTruthy();
    const action = screen.getByText('Create');
    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders without optional icon/desc/action', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.getByText('Empty')).toBeTruthy();
  });
});

describe('Pill', () => {
  it('reflects active state in style + spread attrs and fires onClick', () => {
    const onClick = vi.fn();
    render(
      <Pill active onClick={onClick} aria-pressed title="filter">
        Active pill
      </Pill>,
    );
    const btn = screen.getByRole('button', { name: 'Active pill' });
    // Active = accent bg + dark ink + bold.
    expect(btn.style.background).toBe('var(--accent)');
    expect(btn.style.color).toBe('var(--accent-ink, #051827)');
    expect(btn.style.fontWeight).toBe('600');
    // Spread passthrough.
    expect(btn.getAttribute('title')).toBe('filter');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('inactive uses var(--bg-2) bg + dim fg', () => {
    render(<Pill active={false}>Inactive</Pill>);
    const btn = screen.getByRole('button', { name: 'Inactive' });
    expect(btn.style.background).toBe('var(--bg-2)');
    expect(btn.style.color).toBe('var(--fg-dim)');
    expect(btn.style.fontWeight).toBe('500');
  });

  it('honors the accent override when active', () => {
    render(
      <Pill active accent="var(--good)">
        Custom accent
      </Pill>,
    );
    const btn = screen.getByRole('button', { name: 'Custom accent' });
    expect(btn.style.background).toBe('var(--good)');
    expect(btn.style.border).toContain('var(--good)');
  });
});

describe('ErrorBanner', () => {
  it('renders with role="alert" and its children', () => {
    render(<ErrorBanner>Something broke</ErrorBanner>);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Something broke');
  });
});

describe('friendlyApiError', () => {
  it('maps known codes to friendly copy', () => {
    expect(friendlyApiError('rate_limited')).toMatch(/too many requests/i);
    expect(friendlyApiError('401')).toMatch(/signed in|session/i);
    expect(friendlyApiError('not_found')).toMatch(/couldn’t find|removed/i);
    expect(friendlyApiError('slug_taken')).toMatch(/already taken/i);
  });

  it('falls back to raw, then a generic message', () => {
    expect(friendlyApiError(undefined, 'raw backend text')).toBe('raw backend text');
    expect(friendlyApiError('totally_unknown_code')).toBe('An unexpected error occurred.');
  });
});

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the initial value immediately, then the debounced value', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v), {
      initialProps: { v: 'a' },
    });
    expect(result.current).toBe('a');
    rerender({ v: 'b' });
    // Not yet — debounce window hasn't elapsed.
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS - 1); });
    expect(result.current).toBe('a');
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe('b');
  });

  it('coalesces rapid changes into the last value', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 100), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    act(() => { vi.advanceTimersByTime(50); });
    rerender({ v: 3 });
    act(() => { vi.advanceTimersByTime(50); });
    rerender({ v: 4 });
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe(4);
  });
});
