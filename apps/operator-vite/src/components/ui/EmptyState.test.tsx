// @vitest-environment jsdom
/**
 * EmptyState render coverage — the empty-panel primitive. icon and body are
 * optional; this pins the title-only case, the full case, and the className
 * merge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { EmptyState } from './EmptyState';

afterEach(cleanup);

describe('<EmptyState>', () => {
  it('renders only the title when no icon/body', () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(container.querySelector('.pclsb-empty__title')!.textContent).toBe('Nothing here');
    expect(container.querySelector('.pclsb-empty__icon')).toBeNull();
    expect(container.querySelector('.pclsb-empty__body')).toBeNull();
  });

  it('renders icon and body when provided', () => {
    const { container } = render(
      <EmptyState icon={<i>ic</i>} title="T" body="some body text" />,
    );
    expect(container.querySelector('.pclsb-empty__icon')!.textContent).toContain('ic');
    expect(screen.getByText('some body text')).toBeTruthy();
  });

  it('has the panel empty base class and merges a custom className', () => {
    const { container } = render(<EmptyState title="T" className="mine" />);
    const root = container.querySelector('.pclsb-panel__empty')!;
    expect(root).toBeTruthy();
    expect(root.className).toContain('mine');
  });
});
