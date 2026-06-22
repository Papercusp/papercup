// @vitest-environment jsdom
/**
 * OperatorActiveToggle — the sidebar chip that flips operator interaction mode
 * between active and passive (and surfaces sleeping/quiet states). Lives in the
 * esbuild-stripped _components tier, so destructure/handler bugs only surface
 * under a render+interaction test. We drive: the seeded mode (active default),
 * the click-to-toggle handler, the sleeping/quiet visual states + their no-op
 * clicks, and the imperative setOperatorMode escape hatch — by mocking the
 * sessionStorage-backed operator-converse-tags module to controllable values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const h = vi.hoisted(() => ({
  mode: 'active' as 'active' | 'passive',
  sleepUntil: 0,
  writeMode: vi.fn(),
  writeSleep: vi.fn(),
}));

vi.mock('@papercusp/operator-core/lib/operator-converse-tags', () => ({
  readOperatorModeFromSession: () => h.mode,
  writeOperatorModeToSession: (m: 'active' | 'passive') => { h.writeMode(m); h.mode = m; },
  readSleepUntilMs: () => h.sleepUntil,
  writeSleepUntilMs: (n: number) => { h.writeSleep(n); h.sleepUntil = n; },
}));

// Tooltip just wraps its child — render it transparently.
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { OperatorActiveToggle, setOperatorMode } from './OperatorActiveToggle';

beforeEach(() => {
  h.mode = 'active';
  h.sleepUntil = 0;
  h.writeMode.mockClear();
  h.writeSleep.mockClear();
});
afterEach(cleanup);

describe('OperatorActiveToggle', () => {
  it('renders the Active state by default and seeds the session', () => {
    render(<OperatorActiveToggle />);
    const btn = screen.getByRole('button');
    expect(screen.getByText('Active')).toBeTruthy();
    expect(btn.getAttribute('aria-label')).toMatch(/Click to set passive/i);
    // The mount effect re-writes the seeded mode back to session.
    expect(h.writeMode).toHaveBeenCalledWith('active');
  });

  it('clicking while active flips the mode to passive', () => {
    render(<OperatorActiveToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(h.writeMode).toHaveBeenCalledWith('passive');
    expect(screen.getByText('Passive')).toBeTruthy();
  });

  it('renders the Passive state when the session is seeded passive', () => {
    h.mode = 'passive';
    render(<OperatorActiveToggle />);
    expect(screen.getByText('Passive')).toBeTruthy();
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toMatch(/Click to turn off/i);
  });

  it('clicking while passive turns the herald OFF (3-state cycle)', () => {
    // New cycle (owner 2026-06-22): Active → Passive → Off → Active. Clicking
    // while Passive mutes the herald (silenceVoice via the voice-prefs PATCH),
    // surfaced optimistically as the "Off" label — it no longer flips to active.
    h.mode = 'passive';
    render(<OperatorActiveToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Off')).toBeTruthy();
    expect(h.writeMode).not.toHaveBeenCalledWith('active');
  });

  it('cycles Passive → Off → Active on repeated clicks', () => {
    h.mode = 'passive';
    render(<OperatorActiveToggle />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn); // Passive → Off (optimistic silence)
    expect(screen.getByText('Off')).toBeTruthy();
    h.writeMode.mockClear();
    fireEvent.click(btn); // Off → Active (un-mute + re-engage)
    expect(h.writeMode).toHaveBeenCalledWith('active');
  });

  it('shows a Sleeping label + a wake-on-click when a future sleepUntil is set', () => {
    h.mode = 'active';
    h.sleepUntil = Date.now() + 120_000; // ~2m out
    render(<OperatorActiveToggle />);
    // Label is "Sleeping <Nm>" and the chip carries the sleeping state class.
    expect(screen.getByText(/Sleeping/)).toBeTruthy();
    const btn = screen.getByRole('button');
    expect(btn.className).toMatch(/op-active-toggle--sleeping/);

    h.writeSleep.mockClear();
    fireEvent.click(btn);
    // Sleeping click is a wake — clears sleepUntil but does NOT flip the mode.
    expect(h.writeSleep).toHaveBeenCalledWith(0);
    expect(h.writeMode).not.toHaveBeenCalledWith('passive');
  });

  it('setOperatorMode imperatively writes the mode to session', () => {
    setOperatorMode('passive');
    expect(h.writeMode).toHaveBeenCalledWith('passive');
  });
});
