// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DreamControlSnapshot } from '@papercusp/operator-core/lib/dream/dream-control';

const h = vi.hoisted(() => ({ flag: true, snapshot: null as DreamControlSnapshot | null, loading: false, error: null as Error | null, write: vi.fn(), invalidate: vi.fn(), query: vi.fn() }));
vi.mock('@papercusp/flags/client', () => ({ useFlag: () => h.flag }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: (args: unknown) => { h.query(args); return { data: h.snapshot ? [h.snapshot] : [], loading: h.loading, error: h.error, invalidate: h.invalidate }; } }));
vi.mock('./run-tool', () => ({ runAgentTool: h.write }));
import DreamControl from './DreamControl';

function snapshot(): DreamControlSnapshot {
  return { potSlug: 'pot-a', featureEnabled: true, manual: { active: false, available: true, nextFireAt: null }, automatic: { available: true, enabled: false }, blocker: null, rollingAccountedUsd: 0, limits: { attempts: 3, cycleUsd: 1, rollingUsd: 5 }, lastCycle: null };
}
beforeEach(() => { vi.clearAllMocks(); h.flag = true; h.snapshot = snapshot(); h.loading = false; h.error = null; h.write.mockResolvedValue(undefined); });
afterEach(cleanup);

describe('Learning Dream controls', () => {
  it('opens paused with Auto-dream off and performs no write', () => {
    render(<DreamControl potSlug="pot-a" />);
    expect(screen.getByRole('checkbox', { name: 'Auto-dream' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('No Dream cycle has run for this pot.')).toBeTruthy();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({ queryName: 'learning.dream', args: { potSlug: 'pot-a' } }));
  });

  it('starts, pauses and resumes manually without writing the automatic setting', async () => {
    const view = render(<DreamControl potSlug="pot-a" />);
    for (const enabled of [true, false, true]) {
      fireEvent.click(screen.getByRole('button', { name: enabled ? 'Start manual dreaming' : 'Pause manual dreaming' }));
      await waitFor(() => expect(h.write).toHaveBeenLastCalledWith('dream:control', { pot: 'pot-a', mode: 'manual', enabled }));
      await waitFor(() => expect(h.invalidate).toHaveBeenCalled());
      h.snapshot = { ...h.snapshot!, manual: { ...h.snapshot!.manual, active: enabled } };
      view.rerender(<DreamControl potSlug="pot-a" />);
    }
    expect(screen.getByRole('checkbox', { name: 'Auto-dream' }).getAttribute('aria-checked')).toBe('false');
  });

  it('changes Auto-dream only on its explicit switch and renders the next server snapshot', async () => {
    const view = render(<DreamControl potSlug="pot-a" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-dream' }));
    await waitFor(() => expect(h.write).toHaveBeenCalledWith('dream:control', { pot: 'pot-a', mode: 'auto', enabled: true }));
    h.snapshot = { ...h.snapshot!, automatic: { available: true, enabled: true } };
    view.rerender(<DreamControl potSlug="pot-a" />);
    expect(screen.getByRole('checkbox', { name: 'Auto-dream' }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Auto-dream' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-dream' }));
    await waitFor(() => expect(h.write).toHaveBeenLastCalledWith('dream:control', { pot: 'pot-a', mode: 'auto', enabled: false }));
  });

  it('blocks Start at the budget limit while leaving Pause and disabling Auto-dream available', () => {
    h.snapshot = { ...snapshot(), blocker: 'The 24-hour Dream budget is exhausted.', rollingAccountedUsd: 5 };
    const view = render(<DreamControl potSlug="pot-a" />);
    expect(screen.getByRole('button', { name: 'Start manual dreaming' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Auto-dream' }).hasAttribute('disabled')).toBe(true);
    h.snapshot = { ...h.snapshot, manual: { ...h.snapshot.manual, active: true }, automatic: { available: true, enabled: true } };
    view.rerender(<DreamControl potSlug="pot-a" />);
    expect(screen.getByRole('button', { name: 'Pause manual dreaming' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('checkbox', { name: 'Auto-dream' }).hasAttribute('disabled')).toBe(false);
  });

  it('shows a failed read as unavailable instead of enabling controls from stale data', () => {
    h.error = new Error('offline');
    render(<DreamControl potSlug="pot-a" />);
    expect(screen.getByText('Dream controls could not be read.')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Auto-dream' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.invalidate).toHaveBeenCalled();
  });

  it('surfaces a refused write without claiming that the toggle changed', async () => {
    h.write.mockRejectedValueOnce(new Error('The source repository is missing.'));
    render(<DreamControl potSlug="pot-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start manual dreaming' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The source repository is missing.');
    expect(screen.getByText('Manual dreaming: paused')).toBeTruthy();
  });

  it('renders actual progress and keeps the feature flag distinct from Auto-dream', () => {
    h.snapshot!.lastCycle = { cycleId: 'c', mode: 'manual', attempts: 2, accepted: 1, running: 1, costUsd: 0.42, reason: 'reviewing', updatedAt: '2026-09-07T17:00:00Z' };
    const view = render(<DreamControl potSlug="pot-a" />);
    expect(screen.getByText('2 attempts · 1 accepted proposal · $0.42 accounted')).toBeTruthy();
    h.flag = false;
    view.rerender(<DreamControl potSlug="pot-a" />);
    expect(screen.queryByTestId('dream-control')).toBeNull();
    expect(h.write).not.toHaveBeenCalled();
  });
});
