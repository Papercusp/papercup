// @vitest-environment jsdom
//
// OracleClient — the Oracle system-prompt + memory editor. Real render logic:
// the loading placeholder while /api/oracle/config is in flight, then the form
// seeded from the fetched config (prompt/memory paths surfaced in the intro).
// A render-smoke drives a mocked config fetch with the heavy markdown editor
// stubbed to a textarea. Save POST round-trip is left to e2e.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

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

beforeEach(() => stubConfig(CONFIG));
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
