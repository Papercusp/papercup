// @vitest-environment jsdom
/**
 * KVRow / DetailGrid render coverage — the label/value definition-list primitive
 * and its grid wrapper. Pins the dt/dd structure, className merge, and that
 * DetailGrid maps each item into a KVRow.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { KVRow, DetailGrid } from './KVRow';

afterEach(cleanup);

describe('<KVRow>', () => {
  it('renders label as dt and value as dd', () => {
    const { container } = render(<KVRow label="Name" value="Ada" />);
    const dt = container.querySelector('dt.pclsb-kv-row__label')!;
    const dd = container.querySelector('dd.pclsb-kv-row__value')!;
    expect(dt.textContent).toBe('Name');
    expect(dd.textContent).toBe('Ada');
  });

  it('merges a custom className onto the row', () => {
    const { container } = render(<KVRow label="L" value="V" className="extra" />);
    const row = container.querySelector('.pclsb-kv-row')!;
    expect(row.className).toContain('extra');
  });

  it('renders ReactNode values', () => {
    render(<KVRow label={<span>lbl</span>} value={<strong>val</strong>} />);
    expect(screen.getByText('lbl')).toBeTruthy();
    expect(screen.getByText('val')).toBeTruthy();
  });
});

describe('<DetailGrid>', () => {
  it('maps each item into a KVRow inside a dl', () => {
    const { container } = render(
      <DetailGrid
        items={[
          { label: 'A', value: '1' },
          { label: 'B', value: '2' },
        ]}
      />,
    );
    const dl = container.querySelector('dl.pclsb-detail-grid')!;
    expect(dl).toBeTruthy();
    expect(container.querySelectorAll('.pclsb-kv-row').length).toBe(2);
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('renders an empty dl for no items', () => {
    const { container } = render(<DetailGrid items={[]} className="g" />);
    const dl = container.querySelector('dl.pclsb-detail-grid')!;
    expect(dl).toBeTruthy();
    expect(dl.className).toContain('g');
    expect(container.querySelectorAll('.pclsb-kv-row').length).toBe(0);
  });
});
