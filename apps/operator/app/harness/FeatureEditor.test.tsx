// @vitest-environment jsdom
//
// FeatureEditor — the create/edit modal for harness features. The JSON-tolerant
// audit projection (`safeParse` + `deriveFeatureHistory`) is extracted + tested
// branch-by-branch; a render-smoke drives the embedded editor in create + edit
// modes to confirm the header label and the save-button enable/disable gate.
// @papercusp/sync, nuqs, and the Radix Collapsible/Select are mocked.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { audit, confirmState } = vi.hoisted(() => ({
  audit: { data: [] as unknown[] },
  confirmState: { answer: true },
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: audit.data, loading: false, error: null }),
}));
vi.mock('./useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: async () => confirmState.answer, element: null }),
}));

vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    useQueryState: (_k: string, parser?: { __default?: unknown }) => React.useState(parser?.__default ?? false),
    parseAsBoolean: { withDefault: (d: unknown) => ({ __default: d }) },
  };
});

// Design-system Select → a native select stand-in that forwards value + onChange
// so tests can drive the status (e.g. to "deprecated" for the required-reason guard).
vi.mock('./Select', () => ({
  Select: ({ value, options, ariaLabel, onChange }: { value: string; options: { value: string; label: string }[]; ariaLabel?: string; onChange?: (v: string) => void }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange?.(e.target.value)}>
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
  confirmState.answer = true;
  vi.unstubAllGlobals();
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

  it('create-mode save enables once both ID and title are filled', () => {
    render(<FeatureEditor slug="h" feature={null} onClose={() => {}} onSaved={() => {}} embedded />);
    const save = () => screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    // ID alone → still disabled.
    fireEvent.change(screen.getByPlaceholderText('F-NEW-001'), { target: { value: 'f-fix-001' } });
    expect(save().disabled).toBe(true);
    // + title → enabled. (ID is upper-cased by the onChange.)
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'Fix the thing' } });
    expect(save().disabled).toBe(false);
  });

  it('create save POSTs the new feature (id upper-cased, parsed claims) and calls onSaved', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, text: async () => '' }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const onSaved = vi.fn();
    render(<FeatureEditor slug="h" feature={null} onClose={() => {}} onSaved={onSaved} embedded />);
    fireEvent.change(screen.getByPlaceholderText('F-NEW-001'), { target: { value: 'f-fix-001' } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'Fix it' } }); // title
    fireEvent.change(screen.getByPlaceholderText(/VAL-GRID-001/), { target: { value: 'VAL-1\n VAL-2 \n' } }); // claims
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/harness/h/features');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      id: 'F-FIX-001', title: 'Fix it', claims: ['VAL-1', 'VAL-2'], status: 'todo',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.getByText('saved')).toBeTruthy();
  });

  it('edit save PATCHes the feature URL with attempts + claims', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, text: async () => '' }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    render(
      <FeatureEditor
        slug="h"
        feature={{ id: 'F-7', title: 'Title', status: 'in_progress', attempts: 2, claims: ['VAL-1'] }}
        onClose={() => {}}
        onSaved={() => {}}
        embedded
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/harness/h/features/F-7');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ title: 'Title', status: 'in_progress', attempts: 2, claims: ['VAL-1'] });
  });

  it('blocks save (no fetch) when status is "deprecated" but the reason is blank', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, text: async () => '' }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    render(
      <FeatureEditor
        slug="h"
        feature={{ id: 'F-7', title: 'Title', status: 'in_progress', attempts: 0, claims: [] }}
        onClose={() => {}}
        onSaved={() => {}}
        embedded
      />,
    );
    // Flip status → deprecated. The required deprecation-reason field appears.
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'deprecated' } });
    expect(screen.getByText(/Deprecation reason/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    // The guard short-circuits before any fetch and surfaces the validation toast.
    await waitFor(() => expect(screen.getByText(/Deprecation reason is required/)).toBeTruthy());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('delete confirms, fires DELETE, and calls onSaved', async () => {
    confirmState.answer = true;
    const fetchSpy = vi.fn(async () => ({ ok: true, text: async () => '' }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const onSaved = vi.fn();
    render(
      <FeatureEditor
        slug="h"
        feature={{ id: 'F-7', title: 'Title', status: 'todo', attempts: 0, claims: [] }}
        onClose={() => {}}
        onSaved={onSaved}
        embedded
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/harness/h/features/F-7');
    expect((init as RequestInit).method).toBe('DELETE');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('delete is a no-op when the confirm is declined', async () => {
    confirmState.answer = false;
    const fetchSpy = vi.fn(async () => ({ ok: true, text: async () => '' }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    render(
      <FeatureEditor
        slug="h"
        feature={{ id: 'F-7', title: 'Title', status: 'todo', attempts: 0, claims: [] }}
        onClose={() => {}}
        onSaved={() => {}}
        embedded
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a failed save surfaces the status + body in the toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, text: async () => 'duplicate id' }) as unknown as Response));
    render(<FeatureEditor slug="h" feature={null} onClose={() => {}} onSaved={() => {}} embedded />);
    fireEvent.change(screen.getByPlaceholderText('F-NEW-001'), { target: { value: 'f-1' } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'T' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/save failed: .*409: duplicate id/)).toBeTruthy());
  });

  it('cancel calls onClose', () => {
    const onClose = vi.fn();
    render(<FeatureEditor slug="h" feature={null} onClose={onClose} onSaved={() => {}} embedded />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
