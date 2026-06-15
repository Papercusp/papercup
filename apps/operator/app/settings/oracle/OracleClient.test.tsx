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
});
