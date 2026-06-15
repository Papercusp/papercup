// @vitest-environment jsdom
//
// OracleClient — the Oracle system-prompt + memory editor. Real render logic:
// the loading placeholder while /api/oracle/config is in flight, then the form
// seeded from the fetched config (prompt/memory paths surfaced in the intro),
// then the Save round-trip: a PUT whose body carries the (edited) prompt+memory,
// re-seeding the form on success (toast.success) and surfacing failures on a
// non-ok response (toast.error) without losing the user's edits. The heavy
// markdown editor is stubbed to a textarea so the form wiring stays intact.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The settings markdown editor pulls in Vditor/BlockNote; a textarea stand-in
// keeps the form wiring (value/onChange) intact without the editor stack.
vi.mock('../SettingsMarkdownEditor', () => ({
  SettingsMarkdownEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import OracleClient from './OracleClient';

const CONFIG = {
  prompt: 'You are the Oracle.',
  memory: 'remembered facts',
  prompt_path: '/x/oracle/prompt.md',
  memory_path: '/x/oracle/memory.md',
};

function stubConfig(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch,
  );
}

beforeEach(() => {
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
  (toast.error as ReturnType<typeof vi.fn>).mockClear();
  stubConfig(CONFIG);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<OracleClient />', () => {
  it('shows the loading placeholder before the config resolves', () => {
    render(<OracleClient />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('renders the form seeded from the fetched config', async () => {
    render(<OracleClient />);
    await waitFor(() => expect(screen.getByText('System prompt')).toBeTruthy());
    expect(screen.getByText('Persistent memory')).toBeTruthy();
    // The prompt + memory file paths are surfaced in the intro copy.
    expect(screen.getByText('/x/oracle/prompt.md')).toBeTruthy();
    expect(screen.getByText('/x/oracle/memory.md')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('seeds the prompt editor with the fetched prompt value', async () => {
    render(<OracleClient />);
    await waitFor(() => expect(screen.getByText('System prompt')).toBeTruthy());
    const textareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    expect(textareas.some((t) => t.value === 'You are the Oracle.')).toBe(true);
    expect(textareas.some((t) => t.value === 'remembered facts')).toBe(true);
  });

  it('Save PUTs the edited prompt + memory and re-seeds on success', async () => {
    // First fetch = GET config (the beforeEach stub). Re-stub so the PUT echoes
    // the saved body, then assert the request shape + the success toast.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const sent = JSON.parse(init.body as string);
        return { ok: true, json: async () => ({ ...CONFIG, ...sent }) } as Response;
      }
      return { ok: true, json: async () => CONFIG } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OracleClient />);
    await waitFor(() => expect(screen.getByText('System prompt')).toBeTruthy());

    const promptBox = (screen.getAllByRole('textbox') as HTMLTextAreaElement[])
      .find((t) => t.value === 'You are the Oracle.')!;
    fireEvent.change(promptBox, { target: { value: 'You are the NEW Oracle.' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PUT');
      expect(put).toBeTruthy();
    });
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PUT')!;
    expect(put[0]).toBe('/api/oracle/config');
    const body = JSON.parse((put[1] as RequestInit).body as string);
    expect(body.prompt).toBe('You are the NEW Oracle.');
    expect(body.memory).toBe('remembered facts');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Oracle config saved'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('surfaces a save failure via toast.error on a non-ok PUT (edits preserved)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return { ok: false, status: 422, json: async () => ({}) } as Response;
      return { ok: true, json: async () => CONFIG } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OracleClient />);
    await waitFor(() => expect(screen.getByText('System prompt')).toBeTruthy());

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save failed: HTTP 422'));
    expect(toast.success).not.toHaveBeenCalled();
    // The edited form value is untouched after a failed save.
    const textareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    expect(textareas.some((t) => t.value === 'You are the Oracle.')).toBe(true);
  });
});
