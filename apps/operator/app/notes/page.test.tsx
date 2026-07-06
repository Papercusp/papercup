// @vitest-environment jsdom
/**
 * page.test.tsx — the minimal notes app's page-level behavior (owner-ask-
 * batch-2026-07-06 P-004, WI-3265): the row list renders from `notes.list`,
 * selecting a row loads its content into the editor, "+ New" POSTs a note and
 * selects it, and delete confirms before DELETEing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('nuqs', async () => {
  const withDefault = (defaultValue: unknown) => ({ defaultValue });
  return {
    parseAsString: { withDefault },
    useQueryState: (_key: string, parser?: { defaultValue?: unknown }) =>
      React.useState<unknown>(parser && 'defaultValue' in parser ? parser.defaultValue : null),
  };
});

let syncResult: { data: unknown[]; loading: boolean };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncResult, error: null, fetching: false, invalidate: vi.fn() }),
}));

let confirmResult = true;
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: async () => confirmResult, element: null }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import NotesPage from './page';

const NOTE_A = { id: 'n1', title: 'Groceries', body: 'milk, eggs', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-02T00:00:00Z' };
const NOTE_B = { id: 'n2', title: 'Ideas', body: 'build a notes app', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-03T00:00:00Z' };

beforeEach(() => {
  syncResult = { data: [NOTE_A, NOTE_B], loading: false };
  confirmResult = true;
  fetchMock.mockReset();
});
afterEach(cleanup);

describe('NotesPage', () => {
  it('renders the note list from notes.list', () => {
    render(<NotesPage />);
    expect(screen.getByText('Groceries')).toBeTruthy();
    expect(screen.getByText('Ideas')).toBeTruthy();
  });

  it('shows the empty state when there are no notes', () => {
    syncResult = { data: [], loading: false };
    render(<NotesPage />);
    expect(screen.getByText(/No notes yet/)).toBeTruthy();
  });

  it('selecting a note loads its title + body into the editor', () => {
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Groceries'));
    expect((screen.getByLabelText('Note title') as HTMLInputElement).value).toBe('Groceries');
    expect((screen.getByLabelText('Note body') as HTMLTextAreaElement).value).toBe('milk, eggs');
  });

  it('"+ New" creates a note via POST /api/notes', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, note: { id: 'n3', title: '', body: '', created_at: 'x', updated_at: 'x' } }),
    });
    render(<NotesPage />);
    fireEvent.click(screen.getByText('＋ New'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/notes', expect.objectContaining({ method: 'POST' }));
    });
  });

  it('Delete asks for confirmation, then DELETEs the note', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Groceries'));
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/notes?id=n1', expect.objectContaining({ method: 'DELETE' }));
    });
  });

  it('does not delete when the confirm dialog is declined', async () => {
    confirmResult = false;
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Groceries'));
    fireEvent.click(screen.getByText('Delete'));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
