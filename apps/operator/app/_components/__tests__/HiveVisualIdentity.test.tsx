// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FLAGS, type FlagPayload, resolveWithDefaults } from '@papercusp/flags';
import { setFlagPayload } from '@papercusp/flags/client';

import {
  HIVE_BRAND_COLORS,
  HiveCombMotif,
  HiveNounIcon,
  HivePrimaryMark,
  HiveQueenMark,
} from '../HiveVisualIdentity';
import { OperatorLogoMark } from '../OperatorLogoMark';
import { OperatorWordmarkLockup } from '../OperatorWordmarkLockup';

function setHive(on: boolean): void {
  const payload: FlagPayload = {
    flags: resolveWithDefaults({ [FLAGS.THE_HIVE]: on }),
    evaluatedAt: 1,
    source: 'override',
  };
  act(() => setFlagPayload(payload));
}

afterEach(() => {
  cleanup();
  setHive(false);
});

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
    expect(container.querySelector('pattern')).not.toBeNull();
    expect(container.querySelector('rect')?.getAttribute('fill')).toContain('comb');
  });

  it('keeps the classic logo and wordmark when the Hive flag is off', () => {
    setHive(false);
    const { container } = render(
      <div>
        <OperatorLogoMark data-testid="mark" />
        <OperatorWordmarkLockup />
      </div>,
    );

    expect(container.querySelector('[data-hive-mark]')).toBeNull();
    expect(screen.getByText('Papercup')).not.toBeNull();
    expect(screen.getByText('mission console')).not.toBeNull();
  });

  it('switches logo and default wordmark copy when the Hive flag is on', () => {
    setHive(true);
    const { container } = render(
      <div>
        <OperatorLogoMark data-testid="mark" />
        <OperatorWordmarkLockup />
      </div>,
    );

    expect(container.querySelector('[data-hive-mark="full"]')).not.toBeNull();
    expect(screen.getByText('Papercusp')).not.toBeNull();
    expect(screen.getByText('The Hive')).not.toBeNull();
  });
});
