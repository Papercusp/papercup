// @vitest-environment jsdom
//
// RuntimeView — the plugin-runtime status board. The `on` column flattener
// `onText` (string | string[] → comma-joined string) is extracted + tested. A
// render-smoke (RichGrid stubbed to a faithful row dump) confirms the stat
// header, the empty-state copy per card, and that load-error rows surface their
// message.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// RichGrid is a windowed virtual grid that needs layout APIs jsdom lacks; render
// a plain table-ish dump of the rows so the data is still assertable.
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, getRowId }: { rows: Record<string, unknown>[]; getRowId: (r: Record<string, unknown>) => string }) => (
    <div data-testid="grid">
      {rows.map((r) => (
        <div key={getRowId(r)} data-row>{JSON.stringify(r)}</div>
      ))}
    </div>
  ),
}));

import RuntimeView, { onText } from './RuntimeView';

const EMPTY = {
  loaded: 0,
  errors: 0,
  reactionRules: [],
  plugins: [],
  loadErrors: [],
  initializedPairs: [],
  registeredActions: [],
};

afterEach(cleanup);

describe('onText', () => {
  it('passes a plain string through', () => {
    expect(onText('feature.created')).toBe('feature.created');
  });
  it('comma-joins an array of event names', () => {
    expect(onText(['a', 'b', 'c'])).toBe('a, b, c');
  });
  it('renders an empty array as an empty string', () => {
    expect(onText([])).toBe('');
  });
});

describe('<RuntimeView />', () => {
  it('renders the stat header from the status counts', () => {
    render(<RuntimeView status={{ ...EMPTY, loaded: 4, errors: 2, initializedPairs: ['cf::h1'] }} />);
    expect(screen.getByText('Loaded')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('Load errors')).toBeTruthy();
  });

  it('shows the per-card empty states when nothing is loaded', () => {
    render(<RuntimeView status={EMPTY} />);
    expect(screen.getByText(/No plugins loaded\./i)).toBeTruthy();
    expect(screen.getByText(/No \(plugin, harness\) pair has been initialized/i)).toBeTruthy();
    expect(screen.getByText('None.')).toBeTruthy(); // load errors card
  });

  it('renders the plugins grid when plugins are present', () => {
    render(
      <RuntimeView
        status={{ ...EMPTY, loaded: 1, plugins: [{ name: 'cloudflare', version: '1.0.0', source: 'global' }] }}
      />,
    );
    expect(screen.getByText(/Loaded plugins \(1\)/)).toBeTruthy();
    expect(screen.getByTestId('grid').textContent).toContain('cloudflare');
  });

  it('surfaces a load-error message and its trimmed path', () => {
    render(
      <RuntimeView
        status={{ ...EMPTY, loadErrors: [{ error: 'boom failed to import', path: '/a/b/global-plugins/cf/index.js' }] }}
      />,
    );
    expect(screen.getByText('cf/index.js')).toBeTruthy();
    expect(screen.getByText(/boom failed to import/)).toBeTruthy();
  });
});
