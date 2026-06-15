// @vitest-environment jsdom
//
// FeatureEditor — the create/edit modal for harness features. The JSON-tolerant
// audit projection (`safeParse` + `deriveFeatureHistory`) is extracted + tested
// branch-by-branch; a render-smoke drives the embedded editor in create + edit
// modes to confirm the header label and the save-button enable/disable gate.
// @papercusp/sync, nuqs, and the Radix Collapsible/Select are mocked.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { audit } = vi.hoisted(() => ({ audit: { data: [] as unknown[] } }));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: audit.data, loading: false, error: null }),
}));

vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    useQueryState: (_k: string, parser?: { __default?: unknown }) => React.useState(parser?.__default ?? false),
    parseAsBoolean: { withDefault: (d: unknown) => ({ __default: d }) },
  };
});

// Design-system Select → a native select stand-in surfacing the value.
vi.mock('./Select', () => ({
  Select: ({ value, options, ariaLabel }: { value: string; options: { value: string; label: string }[]; ariaLabel?: string }) => (
    <select aria-label={ariaLabel} value={value} readOnly>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));
// Modal is unused in embedded mode but imported; a passthrough is safe.
vi.mock('./Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import FeatureEditor, { safeParse, deriveFeatureHistory } from './FeatureEditor';

afterEach(() => {
  cleanup();
  audit.data = [];
});

describe('safeParse', () => {
  it('parses valid JSON', () => {
    expect(safeParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeParse('"passed"')).toBe('passed');
  });
  it('returns the raw string for non-JSON', () => {
    expect(safeParse('not json')).toBe('not json');
  });
});

describe('deriveFeatureHistory', () => {
  const rows = [
    { featureId: 'F-1', ts: 1, field: 'status', oldValue: '"todo"', newValue: '"passed"', actor: 'agent' },
    { featureId: 'F-2', ts: 2, field: 'title', oldValue: 'old', newValue: 'new', actor: 'human' },
    { featureId: 'F-1', ts: 3, field: 'attempts', oldValue: null, newValue: '3', actor: null },
  ];

  it('returns null in create mode', () => {
    expect(deriveFeatureHistory(rows, 'F-1', true)).toBeNull();
  });
  it('returns null when there is no feature id', () => {
    expect(deriveFeatureHistory(rows, null, false)).toBeNull();
  });
  it('returns null when the subscription has not hydrated (non-array)', () => {
    expect(deriveFeatureHistory(undefined, 'F-1', false)).toBeNull();
  });

  it('filters to the feature and JSON-parses old/new values', () => {
    const out = deriveFeatureHistory(rows, 'F-1', false)!;
    expect(out).toHaveLength(2);
    const statusRow = out.find((r) => r.field === 'status')!;
    expect(statusRow.old).toBe('todo');
    expect(statusRow.new).toBe('passed');
  });

  it('maps a null old-value to null and parses the new value; actor defaults to empty', () => {
    const out = deriveFeatureHistory(rows, 'F-1', false)!;
    const attemptsRow = out.find((r) => r.field === 'attempts')!;
    expect(attemptsRow.old).toBeNull();
    expect(attemptsRow.new).toBe(3);
    expect(attemptsRow.actor).toBe('');
  });

  it('returns an empty array when no rows match the feature', () => {
    expect(deriveFeatureHistory(rows, 'F-999', false)).toEqual([]);
  });
});

describe('<FeatureEditor />', () => {
  it('shows the "New feature" header in create mode and disables save until id+title', () => {
    render(<FeatureEditor slug="h" feature={null} onClose={() => {}} onSaved={() => {}} embedded />);
    expect(screen.getByText('New feature')).toBeTruthy();
    // No id/title yet → save disabled.
    const save = screen.getByRole('button', { name: /^save$/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows "Edit <id>" and enables save when a feature has a title', () => {
    render(
      <FeatureEditor
        slug="h"
        feature={{ id: 'F-7', title: 'My feature', status: 'todo', attempts: 1, claims: ['VAL-1'] }}
        onClose={() => {}}
        onSaved={() => {}}
        embedded
      />,
    );
    expect(screen.getByText('Edit F-7')).toBeTruthy();
    const save = screen.getByRole('button', { name: /^save$/i });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    // Edit mode exposes a delete button (create mode does not).
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeTruthy();
  });
});
