// @vitest-environment jsdom
//
// PromptStudioPanel — edits the psu-playbook SOURCES with a live preview of the
// assembled per-client prompt. Real render logic: the source list → editor seed,
// the dirty/unsaved indicator (content !== savedContent), and the preview pane
// (chars readout). A render-smoke drives mocked /api/prompt-studio/* endpoints;
// Select is stubbed to a native <select>. The save PUT round-trip is e2e.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../harness/Select', () => ({
  Select: ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} data-testid="select">
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));

function stubRoutes() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/prompt-studio/sources')) {
        return { ok: true, json: async () => ({ dir: '/prompts', sources: [
          { id: 's1', label: 'Engineer base', kind: 'base' },
          { id: 's2', label: 'Claude overlay', kind: 'overlay' },
        ] }) } as unknown as Response;
      }
      if (url.startsWith('/api/prompt-studio/source')) {
        return { ok: true, json: async () => ({ content: '# engineer playbook' }) } as unknown as Response;
      }
      if (url.startsWith('/api/prompt-studio/preview')) {
        return { ok: true, json: async () => ({ text: 'ASSEMBLED PROMPT', chars: 4242, projectGuideSource: 'CLAUDE.md' }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch,
  );
}

import PromptStudioPanel from './PromptStudioPanel';

beforeEach(() => stubRoutes());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<PromptStudioPanel />', () => {
  it('seeds the editor from the first source and lists sources', async () => {
    render(<PromptStudioPanel />);
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('# engineer playbook'));
    // Source picker carries both source labels.
    expect(screen.getByText('Engineer base')).toBeTruthy();
    expect(screen.getByText('Claude overlay')).toBeTruthy();
  });

  it('renders the assembled preview with its char count', async () => {
    render(<PromptStudioPanel />);
    await waitFor(() => expect(screen.getByText('ASSEMBLED PROMPT')).toBeTruthy());
    expect(screen.getByText(/4,242 chars/)).toBeTruthy();
  });

  it('marks the editor dirty (unsaved) after an edit', async () => {
    render(<PromptStudioPanel />);
    const editor = await screen.findByRole('textbox');
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('# engineer playbook'));
    fireEvent.change(editor, { target: { value: '# engineer playbook edited' } });
    expect(screen.getByText('unsaved')).toBeTruthy();
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps Save disabled while pristine', async () => {
    render(<PromptStudioPanel />);
    await waitFor(() => expect(screen.getByText('Engineer base')).toBeTruthy());
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('unsaved')).toBeNull();
  });
});
