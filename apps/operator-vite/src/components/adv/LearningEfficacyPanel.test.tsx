// @vitest-environment jsdom
/**
 * LearningEfficacyPanel render coverage (relight-self-learning-edges-2026-06-14
 * P-020) — the four-metric "is the system LEARNING" strip. Pins: the null
 * (no-data) early return, the per-metric state branches (ok → formatted value,
 * warming → "warming", missing → "—" without crashing — the EI-1454 guard), the
 * pct vs signed formatters, and the gen-0 baseline suffix on the champion chip.
 * The `learning.efficacy` sync query is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  data: undefined as unknown,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: H.data, loading: false, error: null }),
}));

import LearningEfficacyPanel from './LearningEfficacyPanel';

function eff(over: Record<string, unknown> = {}) {
  return {
    autoFixSurvival: { state: 'ok', value: 0.8, detail: null },
    championDelta: { state: 'ok', value: 0.42, detail: null },
    recurrenceDecay: { state: 'warming', value: null, detail: null },
    memoryFpAt5: { state: 'ok', value: 0.1, detail: null },
    gen0Baseline: { composite: 5.95 },
    ...over,
  };
}

beforeEach(() => {
  H.data = undefined;
});
afterEach(cleanup);

describe('<LearningEfficacyPanel>', () => {
  it('returns null (renders nothing) when there is no efficacy row', () => {
    const { container } = render(<LearningEfficacyPanel />);
    expect(container.querySelector('.pc-learning__flow')).toBeNull();
  });

  it('renders the efficacy strip with all four labelled chips', () => {
    H.data = [eff()];
    render(<LearningEfficacyPanel />);
    expect(screen.getByLabelText('Learning efficacy')).toBeTruthy();
    expect(screen.getByText('auto-fix survival')).toBeTruthy();
    expect(screen.getByText('recurrence decay')).toBeTruthy();
    expect(screen.getByText('memory FP@5')).toBeTruthy();
  });

  it('formats an ok pct metric as a rounded percentage', () => {
    H.data = [eff({ autoFixSurvival: { state: 'ok', value: 0.8, detail: null } })];
    render(<LearningEfficacyPanel />);
    expect(screen.getByText('80%')).toBeTruthy();
  });

  it('formats the champion delta as a signed two-decimal number with the gen-0 suffix', () => {
    H.data = [eff({ championDelta: { state: 'ok', value: 0.42, detail: null }, gen0Baseline: { composite: 5.95 } })];
    render(<LearningEfficacyPanel />);
    expect(screen.getByText('+0.42')).toBeTruthy();
    // gen-0 baseline composite is embedded in the chip label
    expect(screen.getByText(/champion Δ vs gen-0 \(5\.95\)/)).toBeTruthy();
  });

  it('renders a negative champion delta with the minus sign', () => {
    H.data = [eff({ championDelta: { state: 'ok', value: -0.18, detail: null }, gen0Baseline: null })];
    render(<LearningEfficacyPanel />);
    expect(screen.getByText('−0.18')).toBeTruthy();
    // no baseline → no parenthetical suffix
    expect(screen.getByText('champion Δ vs gen-0')).toBeTruthy();
  });

  it('renders "warming" for a warming metric', () => {
    H.data = [eff({ recurrenceDecay: { state: 'warming', value: null, detail: null } })];
    render(<LearningEfficacyPanel />);
    expect(screen.getByText('warming')).toBeTruthy();
  });

  it('renders "—" without crashing when a metric is entirely absent (EI-1454 guard)', () => {
    H.data = [eff({ autoFixSurvival: undefined, memoryFpAt5: null })];
    render(<LearningEfficacyPanel />);
    // The dash appears for the absent metrics
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // still rendered the strip
    expect(screen.getByLabelText('Learning efficacy')).toBeTruthy();
  });
});
