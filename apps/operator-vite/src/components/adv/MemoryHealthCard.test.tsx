// @vitest-environment jsdom
//
// MemoryHealthCard render coverage (self-improvement-consume-edges-2026-06-12
// P-031/B-10, EI-366) — the Knowledge sub-view's memory-health strip. Pure
// presentational (prop `memory: MemoryHealth | null`), so no sync mock: each
// test feeds a snapshot and pins the null state, the store counters, the
// zero-hit %/warn threshold, the p50/p90 score formatting, and the EI-366
// fragment-canary chip (renders ONLY when fragmentHits7d > 0).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { MemoryHealth } from '@papercusp/operator-core/lib/memory/knowledge-read';

import MemoryHealthCard from './MemoryHealthCard';

function mem(over: Partial<MemoryHealth> = {}): MemoryHealth {
  return {
    totalMemories: 341,
    entityRows: 1829,
    feedback30d: 12,
    recalls7d: 50,
    zeroHitRate7d: 0.2,
    topScoreP50: 0.71,
    topScoreP90: 0.93,
    fragmentHits7d: 0,
    ...over,
  } as MemoryHealth;
}

afterEach(() => cleanup());

describe('MemoryHealthCard', () => {
  it('renders the unavailable chip when memory is null', () => {
    render(<MemoryHealthCard memory={null} />);
    expect(screen.getByText('memory health unavailable')).toBeTruthy();
    // None of the populated chips render.
    expect(screen.queryByText(/memories/)).toBeNull();
  });

  it('renders the store counters (memories / feedback / recalls)', () => {
    const { container } = render(<MemoryHealthCard memory={mem({ totalMemories: 341, feedback30d: 12, recalls7d: 50 })} />);
    expect(container.textContent).toContain('341');
    expect(container.textContent).toContain('memories');
    expect(container.textContent).toContain('12');
    expect(container.textContent).toContain('feedback events');
    expect(container.textContent).toContain('50');
    expect(container.textContent).toContain('recalls');
  });

  it('shows zero-hit as a percentage when there were recalls', () => {
    const { container } = render(<MemoryHealthCard memory={mem({ recalls7d: 50, zeroHitRate7d: 0.2 })} />);
    const net = container.querySelector('.pc-learning__flownet')!;
    expect(net.textContent).toBe('20%');
  });

  it('shows zero-hit as an em-dash when there were no recalls', () => {
    const { container } = render(<MemoryHealthCard memory={mem({ recalls7d: 0, zeroHitRate7d: 0 })} />);
    const net = container.querySelector('.pc-learning__flownet')!;
    expect(net.textContent).toBe('—');
  });

  it('flags zero-hit as worrying (--warn) only on real volume AND a majority of misses', () => {
    const { container } = render(<MemoryHealthCard memory={mem({ recalls7d: 20, zeroHitRate7d: 0.6 })} />);
    const net = container.querySelector('.pc-learning__flownet')!;
    expect(net.className).toContain('pc-learning__flownet--warn');
    expect(net.className).not.toContain('--flat');
  });

  it('does NOT flag zero-hit worrying below the volume floor (recalls7d < 10)', () => {
    const { container } = render(<MemoryHealthCard memory={mem({ recalls7d: 5, zeroHitRate7d: 0.9 })} />);
    const net = container.querySelector('.pc-learning__flownet')!;
    expect(net.className).toContain('pc-learning__flownet--flat');
    expect(net.className).not.toContain('--warn');
  });

  it('does NOT flag zero-hit worrying below the rate threshold (zeroHitRate7d < 0.5)', () => {
    const { container } = render(<MemoryHealthCard memory={mem({ recalls7d: 100, zeroHitRate7d: 0.49 })} />);
    const net = container.querySelector('.pc-learning__flownet')!;
    expect(net.className).toContain('pc-learning__flownet--flat');
  });

  it('formats p50/p90 scores to 2 decimals, and an em-dash when null', () => {
    const { container } = render(<MemoryHealthCard memory={mem({ topScoreP50: 0.7, topScoreP90: 0.925 })} />);
    expect(container.textContent).toContain('0.70');
    expect(container.textContent).toContain('0.93');

    cleanup();
    const { container: nullScores } = render(<MemoryHealthCard memory={mem({ topScoreP50: null, topScoreP90: null })} />);
    // The score chip shows two em-dashes; assert both present in the score chip text.
    const scoreChip = [...nullScores.querySelectorAll('.pc-learning__flowchip')].find((c) => c.textContent?.includes('score p50'))!;
    expect(scoreChip.textContent).toContain('p50 —');
    expect(scoreChip.textContent).toContain('p90 —');
  });

  it('hides the EI-366 fragment-canary chip when fragmentHits7d is 0', () => {
    render(<MemoryHealthCard memory={mem({ fragmentHits7d: 0 })} />);
    expect(screen.queryByText('fragment hits')).toBeNull();
  });

  it('renders the fragment-canary chip when entity-store leakage recurs (fragmentHits7d > 0)', () => {
    const { container } = render(<MemoryHealthCard memory={mem({ fragmentHits7d: 3 })} />);
    expect(container.textContent).toContain('fragment hits');
    expect(container.textContent).toContain('3');
    // The canary chip carries the red warning color override.
    const canary = [...container.querySelectorAll('.pc-learning__flowchip')].find((c) => c.textContent?.includes('fragment hits'))! as HTMLElement;
    expect(canary.style.color).toBe('rgb(248, 113, 113)');
  });

  // WI-10004133: a monitor fire that recorded no bench row must be visible, or the FP@5
  // chip reads as current while it is stale.
  describe('last precision attempt', () => {
    const latest = {
      ranAt: '2026-09-20T03:00:00.000Z', backend: 'hybrid', fpAt5: 0.17, rAt10: 0.8, pAt5: 0.5, mrr: 0.6,
      medianTopScore: 0.7, floorCosine: 0.45, floorLex: 0.2, corpusN: 100, goldN: 40, latencyP50Ms: 10,
    };
    const attempt = (over: Record<string, unknown>) => ({
      attemptedAt: '2026-09-27T03:00:00.000Z', outcome: 'failed', stage: 'bench', error: 'worker timed out',
      rowId: null, jevGate: false, ...over,
    });
    const withPrecision = (lastAttempt: unknown) =>
      mem({ precision: { latest, trend: [latest], fpAt5Delta: null, runCount: 1, lastAttempt } as MemoryHealth['precision'] });

    it('renders a red failed chip with the stage and error when the newest fire failed after the latest run', () => {
      render(<MemoryHealthCard memory={withPrecision(attempt({}))} />);
      const chip = screen.getByTestId('memory-precision-last-attempt');
      expect(chip.textContent).toContain('failed');
      expect(chip.textContent).toContain('bench');
      expect(chip.getAttribute('title')).toContain('worker timed out');
      expect((chip as HTMLElement).style.color).toBe('rgb(248, 113, 113)');
    });

    it('renders a neutral skipped chip for a flag-off fire', () => {
      render(<MemoryHealthCard memory={withPrecision(attempt({ outcome: 'flag-off', stage: null, error: null }))} />);
      const chip = screen.getByTestId('memory-precision-last-attempt');
      expect(chip.textContent).toContain('skipped');
      expect((chip as HTMLElement).style.color).toBe('');
    });

    it('renders nothing when the newest fire recorded a row, or when the failure predates the latest run', () => {
      render(<MemoryHealthCard memory={withPrecision(attempt({ outcome: 'recorded', stage: null, error: null, rowId: 7 }))} />);
      expect(screen.queryByTestId('memory-precision-last-attempt')).toBeNull();
      cleanup();
      render(<MemoryHealthCard memory={withPrecision(attempt({ attemptedAt: '2026-09-19T03:00:00.000Z' }))} />);
      expect(screen.queryByTestId('memory-precision-last-attempt')).toBeNull();
      cleanup();
      render(<MemoryHealthCard memory={withPrecision(null)} />);
      expect(screen.queryByTestId('memory-precision-last-attempt')).toBeNull();
    });

    it('renders the failed chip even when no run was ever recorded', () => {
      render(
        <MemoryHealthCard
          memory={mem({ precision: { latest: null, trend: [], fpAt5Delta: null, runCount: 0, lastAttempt: attempt({}) } as MemoryHealth['precision'] })}
        />,
      );
      expect(screen.getByTestId('memory-precision-last-attempt').textContent).toContain('failed');
    });
  });
});
