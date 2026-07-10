// @vitest-environment jsdom
/**
 * ModelTiersOverride.test — the 👑 model-tier session override (D-006, #4).
 *
 * Covers the pure override math (effective spec, default-vs-override, build-or-
 * clear) and the rendered editor: baseline tiers from @papercusp/sync, the
 * default/override badge, and that editing a spec writes the computed override.
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

  it('renders the baseline tiers with default badges in the compact Models section', async () => {
    render(<ModelTiersOverride override={null} onWrite={vi.fn()} busy={false} />, { wrapper: Wrap });
    expect(H.useSyncQuery).toHaveBeenCalledWith({
      queryName: 'agentConfig.modelTiersBaseline',
      args: {},
      staleTime: 60_000,
    });
    await waitFor(() => expect(screen.getByText('fast')).toBeTruthy());
    expect(screen.getByText('std')).toBeTruthy();
    expect(screen.getAllByText('default').length).toBe(2);
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.getByText('Models')).toBeTruthy();
    expect(screen.queryByText(/Session override of the workspace model tiers/)).toBeNull();
  });

  it('shows the override badge + value when a tier is overridden', async () => {
    render(<ModelTiersOverride override={[{ name: 'fast', spec: 'opus:xhigh' }]} onWrite={vi.fn()} busy={false} />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByText('fast')).toBeTruthy());
    expect(screen.getByText('override')).toBeTruthy();
    expect((screen.getByLabelText('fast model spec') as HTMLInputElement).value).toBe('opus:xhigh');
    expect(screen.getByText('1 custom')).toBeTruthy();
  });

  it('editing a tier spec + blurring writes the computed override', async () => {
    const onWrite = vi.fn();
    render(<ModelTiersOverride override={null} onWrite={onWrite} busy={false} />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByLabelText('std model spec')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('std model spec'), { target: { value: 'opus' } });
    fireEvent.blur(screen.getByLabelText('std model spec'));
    expect(onWrite).toHaveBeenCalledWith([
      { name: 'fast', spec: 'haiku' },
      { name: 'std', spec: 'opus' },
    ]);
  });
});
