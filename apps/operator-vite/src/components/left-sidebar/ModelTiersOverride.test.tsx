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

  it('renders the baseline tiers with default badges + the session-override note', async () => {
    render(<ModelTiersOverride override={null} onWrite={vi.fn()} busy={false} />);
    expect(H.useSyncQuery).toHaveBeenCalledWith({
      queryName: 'agentConfig.modelTiersBaseline',
      args: {},
      staleTime: 60_000,
    });
    await waitFor(() => expect(screen.getByText('fast')).toBeTruthy());
    expect(screen.getByText('std')).toBeTruthy();
    expect(screen.getAllByText('default').length).toBe(2);
    expect(screen.getByText('workspace default')).toBeTruthy();
    expect(screen.getByText(/Session override of the workspace model tiers/)).toBeTruthy();
  });

  it('shows the override badge + value when a tier is overridden', async () => {
    render(<ModelTiersOverride override={[{ name: 'fast', spec: 'opus:xhigh' }]} onWrite={vi.fn()} busy={false} />);
    await waitFor(() => expect(screen.getByText('fast')).toBeTruthy());
    expect(screen.getByText('override')).toBeTruthy();
    expect((screen.getByLabelText('fast model spec') as HTMLInputElement).value).toBe('opus:xhigh');
    expect(screen.getByText('session override')).toBeTruthy();
  });

  it('editing a tier spec + blurring writes the computed override', async () => {
    const onWrite = vi.fn();
    render(<ModelTiersOverride override={null} onWrite={onWrite} busy={false} />);
    await waitFor(() => expect(screen.getByLabelText('std model spec')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('std model spec'), { target: { value: 'opus' } });
    fireEvent.blur(screen.getByLabelText('std model spec'));
    expect(onWrite).toHaveBeenCalledWith([
      { name: 'fast', spec: 'haiku' },
      { name: 'std', spec: 'opus' },
    ]);
  });
});
