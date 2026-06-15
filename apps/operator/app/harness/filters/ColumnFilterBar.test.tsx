// @vitest-environment jsdom
//
// ColumnFilterBar — the visual surface for the generic column-filter system.
// The whole bar is gated behind the GRID_COLUMN_FILTERS flag (renders null when
// off); when on it shows removable chips for active filters, an "Add filter"
// Select of the still-addable columns, and a "Clear all" when any is active.
// `headerText` (the label resolver) is exported + tested; a render-smoke drives
// the bar with a stub controller + flag flips. The design-system Select /
// Popover / Checkbox primitives are stubbed to passthroughs (out of scope).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FilterableColumn } from '@papercusp/grid-core';

// Flag — flip per test via the hoisted holder.
const { flagState } = vi.hoisted(() => ({ flagState: { on: true } }));
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => flagState.on }));

// Design-system primitives — render minimal stand-ins that surface what the
// bar passes (the Select options, the Popover open-state + children).
vi.mock('../Select', () => ({
  Select: ({ options, ariaLabel }: { options: { value: string; label: string }[]; ariaLabel?: string }) => (
    <select aria-label={ariaLabel} data-testid="add-filter-select">
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));
vi.mock('../Popover', () => ({
  Popover: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="editor-popover">{children}</div> : null,
}));
vi.mock('../Checkbox', () => ({
  Checkbox: () => <input type="checkbox" readOnly />,
}));

import { ColumnFilterBar, headerText } from './ColumnFilterBar';

afterEach(() => {
  cleanup();
  flagState.on = true;
});

describe('headerText', () => {
  it('uses a non-empty string header verbatim', () => {
    expect(headerText({ key: 'k', header: 'Title' })).toBe('Title');
  });
  it('stringifies a numeric header', () => {
    expect(headerText({ key: 'k', header: 42 })).toBe('42');
  });
  it('falls back to headerText when header is an empty string', () => {
    expect(headerText({ key: 'k', header: '', headerText: 'Icon col' })).toBe('Icon col');
  });
  it('falls back to the key when neither header nor headerText is usable', () => {
    expect(headerText({ key: 'mykey', header: '' })).toBe('mykey');
    expect(headerText({ key: 'mykey', header: <span>x</span> as unknown })).toBe('mykey');
  });
});

type Row = { kind: string };

function mkController(cols: FilterableColumn<Row>[]) {
  return {
    filterableColumns: cols,
    valueFor: () => undefined,
    setValue: () => {},
    remove: () => {},
    optionsFor: () => [],
  };
}

const COLS: FilterableColumn<Row>[] = [
  { key: 'kind', header: 'Kind', filter: { type: 'enum', accessor: (r) => r.kind } },
  { key: 'name', header: 'Name', filter: { type: 'text', accessor: () => '' } },
];

describe('<ColumnFilterBar />', () => {
  it('renders nothing when the grid-column-filters flag is off', () => {
    flagState.on = false;
    const { container } = render(
      <ColumnFilterBar controller={mkController(COLS)} activeChips={[]} hasActive={false} clearAll={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('lists the addable columns in the Add-filter Select when flag is on', () => {
    render(
      <ColumnFilterBar controller={mkController(COLS)} activeChips={[]} hasActive={false} clearAll={() => {}} />,
    );
    const select = screen.getByTestId('add-filter-select');
    // Both filterable columns are addable (none active yet) + the placeholder.
    expect(select.textContent).toContain('Kind');
    expect(select.textContent).toContain('Name');
    expect(select.textContent).toContain('Add filter…');
  });

  it('renders a removable chip per active filter and a Clear all button', () => {
    render(
      <ColumnFilterBar
        controller={mkController(COLS)}
        activeChips={[{ colKey: 'kind', label: 'Kind: Bug', clear: () => {} }]}
        hasActive
        clearAll={() => {}}
      />,
    );
    // The active chip shows its label.
    expect(screen.getByText('Kind: Bug')).toBeTruthy();
    // Its × carries an accessible remove label.
    expect(screen.getByLabelText('Remove Kind: Bug filter')).toBeTruthy();
    // Clear all surfaces when any filter is active.
    expect(screen.getByRole('button', { name: /clear all/i })).toBeTruthy();
  });

  it('excludes already-active columns from the Add-filter Select', () => {
    render(
      <ColumnFilterBar
        controller={mkController(COLS)}
        activeChips={[{ colKey: 'kind', label: 'Kind: Bug', clear: () => {} }]}
        hasActive
        clearAll={() => {}}
      />,
    );
    // 'kind' is active → only 'name' remains addable. The Select still renders
    // (one column is still addable).
    const select = screen.getByTestId('add-filter-select');
    expect(select.textContent).toContain('Name');
    // 'Kind' should not be offered as an addable option anymore.
    const options = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).not.toContain('Kind');
  });

  it('hides the Add-filter Select entirely when every column is already active', () => {
    render(
      <ColumnFilterBar
        controller={mkController(COLS)}
        activeChips={[
          { colKey: 'kind', label: 'Kind: Bug', clear: () => {} },
          { colKey: 'name', label: 'Name: x', clear: () => {} },
        ]}
        hasActive
        clearAll={() => {}}
      />,
    );
    expect(screen.queryByTestId('add-filter-select')).toBeNull();
  });
});
