// @vitest-environment jsdom
/**
 * Shared components/ui primitive coverage (operator-vite-ui-consolidation U2).
 *
 * The four originally-extracted primitives (StatusPill / ListRow / EmptyState /
 * KVRow+DetailGrid) shipped WITHOUT tests; this pins their canonical-token
 * markup plus the two primitives added to complete the set — Chip / ChipBar
 * (U2-5). Every sidebar panel now depends on these, so a silent regression in
 * the shared markup would ripple app-wide; this is the guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StatusPill, ListRow, EmptyState, KVRow, DetailGrid, Chip, ChipBar } from './index';

afterEach(() => cleanup());

describe('StatusPill', () => {
  it('renders the label with the canonical tone class', () => {
    const { container } = render(<StatusPill tone="good" label="healthy" />);
    const el = container.querySelector('.pclsb-pill');
    expect(el).toBeTruthy();
    expect(el?.className).toContain('pclsb-pill--good');
    expect(el?.textContent).toBe('healthy');
  });

  it('passes an extra className through', () => {
    const { container } = render(<StatusPill tone="bad" label="x" className="extra" />);
    const el = container.querySelector('.pclsb-pill');
    expect(el?.className).toContain('pclsb-pill--bad');
    expect(el?.className).toContain('extra');
  });
});

describe('ListRow', () => {
  it('renders title / sub / meta and fires onClick from the row', () => {
    const onClick = vi.fn();
    const { container } = render(
      <ListRow title="T" sub="S" meta="M" indicator={<i data-testid="ind" />} action="A" isClickable onClick={onClick} />,
    );
    expect(screen.getByText('T')).toBeTruthy();
    expect(screen.getByText('S')).toBeTruthy();
    expect(screen.getByText('M')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByTestId('ind')).toBeTruthy();
    const row = container.querySelector('.pclsb-row');
    expect(row?.className).toContain('is-clickable');
    fireEvent.click(row as Element);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('omits optional regions and the clickable flag by default', () => {
    const { container } = render(<ListRow title="only-title" />);
    const row = container.querySelector('.pclsb-row');
    expect(row?.className).not.toContain('is-clickable');
    expect(container.querySelector('.pclsb-row__sub')).toBeNull();
    expect(container.querySelector('.pclsb-dot')).toBeNull();
  });
});

describe('EmptyState', () => {
  it('renders title + body in the canonical empty container', () => {
    const { container } = render(<EmptyState title="Nothing here" body="add some" icon={<i data-testid="ico" />} />);
    expect(container.querySelector('.pclsb-panel__empty')).toBeTruthy();
    expect(screen.getByText('Nothing here')).toBeTruthy();
    expect(screen.getByText('add some')).toBeTruthy();
    expect(screen.getByTestId('ico')).toBeTruthy();
  });
});

describe('KVRow / DetailGrid', () => {
  it('KVRow renders a dt/dd pair with the canonical classes', () => {
    const { container } = render(<KVRow label="k" value="v" />);
    expect(container.querySelector('dt.pclsb-kv-row__label')?.textContent).toBe('k');
    expect(container.querySelector('dd.pclsb-kv-row__value')?.textContent).toBe('v');
  });

  it('DetailGrid renders one KVRow per item inside a <dl>', () => {
    const { container } = render(
      <DetailGrid items={[{ label: 'a', value: '1' }, { label: 'b', value: '2' }]} />,
    );
    expect(container.querySelector('dl.pclsb-detail-grid')).toBeTruthy();
    expect(container.querySelectorAll('.pclsb-kv-row').length).toBe(2);
  });
});

describe('Chip', () => {
  it('renders a button on the chip token and forwards onClick; no is-on by default', () => {
    const onClick = vi.fn();
    render(<Chip onClick={onClick}>comms</Chip>);
    const btn = screen.getByRole('button', { name: 'comms' });
    expect(btn.className).toContain('pclsb-chipbtn');
    expect(btn.className).not.toContain('is-on');
    expect(btn.getAttribute('type')).toBe('button');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('adds is-on when active', () => {
    render(<Chip active>x</Chip>);
    expect(screen.getByRole('button', { name: 'x' }).className).toContain('is-on');
  });

  it('forwards native button props (disabled, aria-label, data-testid)', () => {
    render(<Chip disabled aria-label="lbl" data-testid="tid">y</Chip>);
    const btn = screen.getByTestId('tid');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('lbl');
  });
});

describe('ChipBar', () => {
  it('wraps chips in a role=group container', () => {
    render(
      <ChipBar data-testid="bar">
        <Chip>a</Chip>
        <Chip>b</Chip>
      </ChipBar>,
    );
    const bar = screen.getByTestId('bar');
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.querySelectorAll('button.pclsb-chipbtn').length).toBe(2);
  });
});
