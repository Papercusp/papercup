// @vitest-environment jsdom
/**
 * StatusPill render coverage — the tone-keyed status badge. Pins the base class,
 * the per-tone modifier class for each of the four tones, the label text, and a
 * merged custom className.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { StatusPill, type PillTone } from './StatusPill';

afterEach(cleanup);

describe('<StatusPill>', () => {
  it('renders the label text', () => {
    render(<StatusPill tone="good" label="OK" />);
    expect(screen.getByText('OK')).toBeTruthy();
  });

  it.each<PillTone>(['good', 'warn', 'bad', 'neutral'])(
    'applies the base + tone modifier class for tone=%s',
    (tone) => {
      const { container } = render(<StatusPill tone={tone} label={tone} />);
      const pill = container.querySelector('.pclsb-pill')!;
      expect(pill).toBeTruthy();
      expect(pill.className).toContain(`pclsb-pill--${tone}`);
    },
  );

  it('merges a custom className', () => {
    const { container } = render(<StatusPill tone="neutral" label="x" className="mine" />);
    expect(container.querySelector('.pclsb-pill')!.className).toContain('mine');
  });
});
