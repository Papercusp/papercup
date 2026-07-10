// @vitest-environment jsdom
/**
 * ModelTiersOverride.test — the 👑 model-tier session override (D-006, #4).
 *
 * Covers the pure override math (effective spec, default-vs-override, build-or-
 * clear) and the rendered editor: baseline tiers from @papercusp/sync, the
 * editable tier rows, custom-state reset affordance, and spec writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

import ModelTiersOverride, { effectiveSpec, isOverridden, withTierSpec } from './ModelTiersOverride';

const H = vi.hoisted(() => ({
  syncResult: {
    data: [
      { name: 'fast', spec: 'haiku' },
      { name: 'std', spec: 'sonnet' },
    ],
    loading: false,
    error: null,
  },
  useSyncQuery: vi.fn(),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: H.useSyncQuery,
}));

const BASELINE = [
  { name: 'fast', spec: 'haiku' },
  { name: 'std', spec: 'sonnet' },
];
const Wrap = ({ children }: { children: ReactNode }) => <NuqsTestingAdapter searchParams="?qModels=true">{children}</NuqsTestingAdapter>;
const ClosedWrap = ({ children }: { children: ReactNode }) => <NuqsTestingAdapter>{children}</NuqsTestingAdapter>;

describe('override math', () => {
  it('effectiveSpec prefers the override, falls back to baseline', () => {
    expect(effectiveSpec(BASELINE, null, 'fast')).toBe('haiku');
    expect(effectiveSpec(BASELINE, [{ name: 'fast', spec: 'opus' }], 'fast')).toBe('opus');
  });

  it('isOverridden is true only when the override differs from baseline', () => {
    expect(isOverridden(BASELINE, null, 'fast')).toBe(false);
    expect(isOverridden(BASELINE, [{ name: 'fast', spec: 'haiku' }], 'fast')).toBe(false);
    expect(isOverridden(BASELINE, [{ name: 'fast', spec: 'opus' }], 'fast')).toBe(true);
  });

  it('withTierSpec builds the full override, or null when it matches baseline', () => {
    expect(withTierSpec(BASELINE, null, 'fast', 'opus:xhigh')).toEqual([
      { name: 'fast', spec: 'opus:xhigh' },
      { name: 'std', spec: 'sonnet' },
    ]);
    // setting it back to baseline clears the override
    expect(withTierSpec(BASELINE, [{ name: 'fast', spec: 'opus' }], 'fast', 'haiku')).toBeNull();
    // a no-op edit (already baseline) ⇒ null
    expect(withTierSpec(BASELINE, null, 'fast', 'haiku')).toBeNull();
  });
});

describe('ModelTiersOverride render', () => {
  beforeEach(() => {
    H.syncResult = { data: BASELINE, loading: false, error: null };
    H.useSyncQuery.mockImplementation(() => H.syncResult);
  });
  afterEach(() => {
    cleanup();
    H.useSyncQuery.mockReset();
  });

  it('defaults to a compact Models summary', () => {
    render(<ModelTiersOverride override={null} onWrite={vi.fn()} busy={false} />, { wrapper: ClosedWrap });
    expect(screen.getByText('Models')).toBeTruthy();
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.queryByLabelText('fast model spec')).toBeNull();
  });

  it('renders baseline tiers as clean label-and-field rows', async () => {
    render(<ModelTiersOverride override={null} onWrite={vi.fn()} busy={false} />, { wrapper: Wrap });
    expect(H.useSyncQuery).toHaveBeenCalledWith({
      queryName: 'agentConfig.modelTiersBaseline',
      args: {},
      staleTime: 60_000,
    });
    await waitFor(() => expect(screen.getByText('fast')).toBeTruthy());
    expect(screen.getByText('std')).toBeTruthy();
    expect(screen.queryByText('default')).toBeNull();
    expect(screen.queryByRole('button', { name: /Use workspace model for/ })).toBeNull();
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.getByText('Models')).toBeTruthy();
    expect(screen.queryByText(/Session override of the workspace model tiers/)).toBeNull();
  });

  it('highlights an overridden tier with a direct workspace reset action', async () => {
    render(<ModelTiersOverride override={[{ name: 'fast', spec: 'opus:xhigh' }]} onWrite={vi.fn()} busy={false} />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByText('fast')).toBeTruthy());
    expect(screen.queryByText('override')).toBeNull();
    expect((screen.getByLabelText('fast model spec') as HTMLInputElement).value).toBe('opus:xhigh');
    expect(screen.getByText('1 custom')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use workspace model for fast' })).toBeTruthy();
  });

  it('resets a custom tier directly from its row', async () => {
    const onWrite = vi.fn();
    render(<ModelTiersOverride override={[{ name: 'fast', spec: 'opus:xhigh' }]} onWrite={onWrite} busy={false} />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use workspace model for fast' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Use workspace model for fast' }));
    expect(onWrite).toHaveBeenCalledWith(null);
  });

  it('shows explicit apply and discard actions for an edited tier', async () => {
    const onWrite = vi.fn();
    render(<ModelTiersOverride override={null} onWrite={onWrite} busy={false} />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByLabelText('std model spec')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('std model spec'), { target: { value: 'opus' } });
    fireEvent.blur(screen.getByLabelText('std model spec'));
    expect(onWrite).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Apply model change for std' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard model change for std' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply model change for std' }));
    expect(onWrite).toHaveBeenCalledWith([
      { name: 'fast', spec: 'haiku' },
      { name: 'std', spec: 'opus' },
    ]);
  });

  it('discards a draft without writing and restores the saved value', async () => {
    const onWrite = vi.fn();
    render(<ModelTiersOverride override={null} onWrite={onWrite} busy={false} />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByLabelText('std model spec')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('std model spec'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard model change for std' }));
    expect((screen.getByLabelText('std model spec') as HTMLInputElement).value).toBe('sonnet');
    expect(onWrite).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Apply model change for std' })).toBeNull();
  });

  it('blocks an empty model spec and allows Enter to apply a valid draft', async () => {
    const onWrite = vi.fn();
    render(<ModelTiersOverride override={null} onWrite={onWrite} busy={false} />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByLabelText('std model spec')).toBeTruthy());
    const input = screen.getByLabelText('std model spec');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByRole('button', { name: 'Apply model change for std' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onWrite).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'opus:high' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onWrite).toHaveBeenCalledWith([
      { name: 'fast', spec: 'haiku' },
      { name: 'std', spec: 'opus:high' },
    ]);
  });
});
