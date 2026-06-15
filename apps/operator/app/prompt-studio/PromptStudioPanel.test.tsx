// @vitest-environment jsdom
//
// PromptStudioPanel — edits the psu-playbook SOURCES with a live preview of the
// assembled per-client prompt. Real render logic: the source list → editor seed,
// the dirty/unsaved indicator (content !== savedContent), and the preview pane
// (chars readout). A render-smoke drives mocked /api/prompt-studio/* endpoints;
// Select is stubbed to a native <select>. The save PUT round-trip is e2e.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

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

  it('saving PUTs the edited content, clears the dirty flag and toasts success', async () => {
    // Track PUTs against /api/prompt-studio/source.
    const puts: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/prompt-studio/sources')) {
        return { ok: true, json: async () => ({ dir: '/p', sources: [{ id: 's1', label: 'Engineer base', kind: 'base' }] }) } as Response;
      }
      if (url.startsWith('/api/prompt-studio/source') && init?.method === 'PUT') {
        puts.push(init);
        return { ok: true, json: async () => ({ ok: true, note: 'queued' }) } as Response;
      }
      if (url.startsWith('/api/prompt-studio/source')) {
        return { ok: true, json: async () => ({ content: '# base' }) } as Response;
      }
      if (url.startsWith('/api/prompt-studio/preview')) {
        return { ok: true, json: async () => ({ text: 'P', chars: 1, projectGuideSource: 'x' }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch);

    render(<PromptStudioPanel />);
    const editor = await screen.findByRole('textbox');
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('# base'));
    fireEvent.change(editor, { target: { value: '# base v2' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(puts.length).toBe(1));
    expect(JSON.parse(puts[0].body as string)).toEqual({ id: 's1', content: '# base v2' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved', expect.anything()));
    // Dirty flag clears once saved.
    await waitFor(() => expect(screen.queryByText('unsaved')).toBeNull());
  });

  it('surfaces a save failure (non-ok PUT) via toast.error and stays dirty', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/prompt-studio/sources')) {
        return { ok: true, json: async () => ({ dir: '/p', sources: [{ id: 's1', label: 'Engineer base', kind: 'base' }] }) } as Response;
      }
      if (url.startsWith('/api/prompt-studio/source') && init?.method === 'PUT') {
        return { ok: false, status: 500, json: async () => ({ ok: false, error: 'disk full' }) } as Response;
      }
      if (url.startsWith('/api/prompt-studio/source')) {
        return { ok: true, json: async () => ({ content: '# base' }) } as Response;
      }
      if (url.startsWith('/api/prompt-studio/preview')) {
        return { ok: true, json: async () => ({ text: 'P', chars: 1, projectGuideSource: 'x' }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch);

    render(<PromptStudioPanel />);
    const editor = await screen.findByRole('textbox');
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('# base'));
    fireEvent.change(editor, { target: { value: '# base v2' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Save failed', { description: 'disk full' }));
    // Still dirty — the save didn't take.
    expect(screen.getByText('unsaved')).toBeTruthy();
  });

  it('switching the preview agent re-fetches the preview with the new agent', async () => {
    const previewUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/prompt-studio/sources')) {
        return { ok: true, json: async () => ({ dir: '/p', sources: [{ id: 's1', label: 'Engineer base', kind: 'base' }] }) } as Response;
      }
      if (url.startsWith('/api/prompt-studio/source')) {
        return { ok: true, json: async () => ({ content: '# base' }) } as Response;
      }
      if (url.startsWith('/api/prompt-studio/preview')) {
        previewUrls.push(url);
        return { ok: true, json: async () => ({ text: 'P', chars: 1, projectGuideSource: 'x' }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch);

    render(<PromptStudioPanel />);
    await waitFor(() => expect(previewUrls.length).toBeGreaterThan(0));
    expect(previewUrls[0]).toContain('agent=claude');

    // The agent picker is the second <select> (source, agent, profile).
    const selects = screen.getAllByTestId('select');
    fireEvent.change(selects[1], { target: { value: 'omp' } });
    await waitFor(() => expect(previewUrls.some((u) => u.includes('agent=omp'))).toBe(true));
  });
});
