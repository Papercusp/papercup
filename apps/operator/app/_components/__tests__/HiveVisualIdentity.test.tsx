// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HIVE_BRAND_COLORS,
  HiveCombMotif,
  HiveNounIcon,
  HivePrimaryMark,
  HiveQueenMark,
} from '../HiveVisualIdentity';

afterEach(cleanup);

describe('Hive visual identity components', () => {
  it('renders scalable primary and Queen marks', () => {
    const { container } = render(
      <div>
        <HivePrimaryMark data-testid="primary" />
        <HiveQueenMark data-testid="queen" monochrome />
      </div>,
    );

    const primary = container.querySelector('[data-testid="primary"]');
    const queen = container.querySelector('[data-testid="queen"]');
    expect(primary?.getAttribute('viewBox')).toBe('0 0 128 128');
    expect(queen?.getAttribute('viewBox')).toBe('0 0 128 128');
    expect(container.innerHTML).toContain(HIVE_BRAND_COLORS.honeyStrong);
    expect(container.innerHTML).toContain('currentColor');
  });

  it('covers each Hive lexicon noun with an icon', () => {
    const kinds = ['hive', 'swarm', 'queen', 'bee', 'cell', 'comb', 'frame'] as const;
    const { container } = render(
      <div>
        {kinds.map((kind) => (
          <HiveNounIcon key={kind} kind={kind} data-kind={kind} />
        ))}
      </div>,
    );

    for (const kind of kinds) {
      expect(container.querySelector(`[data-kind="${kind}"]`)).not.toBeNull();
    }
  });

  it('renders the comb motif as a reusable SVG texture', () => {
    const { container } = render(<HiveCombMotif data-testid="motif" />);
    const motif = container.querySelector('[data-testid="motif"]');
    expect(motif?.getAttribute('viewBox')).toBe('0 0 360 120');
    expect(container.querySelectorAll('path').length).toBeGreaterThan(3);
  });
});
