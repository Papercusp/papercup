// @vitest-environment jsdom
//
// MemoryBrowser — the per-harness memory-map file editor. The format helpers
// (`fmtSize`, `fmtAgo`) and the tier grouping (`groupByTier`) are extracted +
// tested branch-by-branch; a render-smoke drives the left-rail grouping with a
// mocked /memory fetch + a mocked text-artifacts sync subscription. Monaco /
// MarkdownEditor / the save-shortcut are stubbed (out of scope, jsdom-hostile).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Monaco references browser layout APIs jsdom lacks; the editor isn't under
// test, so a marker stand-in keeps the smoke clean.
// Stubs forward `value`/`onChange` so tests can read the loaded draft and drive
// edits (the dirty-gate behind revert/save). Monaco/vditor layout APIs are
// jsdom-hostile, so we substitute plain controlled inputs.
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value?: string; onChange?: (v: string | undefined) => void }) => (
    <textarea data-testid="monaco" value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));
vi.mock('../_components/MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <textarea data-testid="md-editor" value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));
vi.mock('../../lib/hotkeys', () => ({ useShortcut: () => {} }));

vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    useQueryState: () => React.useState<string | null>(null),
    parseAsString: {},
  };
});

const { artifactRows } = vi.hoisted(() => ({ artifactRows: [] as unknown[] }));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: artifactRows, loading: false, error: null }),
}));

import MemoryBrowser, { fmtSize, fmtAgo, groupByTier } from './MemoryBrowser';

afterEach(cleanup);

describe('fmtSize', () => {
  it('renders an em-dash for zero bytes', () => {
    expect(fmtSize(0)).toBe('—');
  });
  it('renders raw bytes under 1KB', () => {
    expect(fmtSize(512)).toBe('512B');
  });
  it('renders one-decimal KB under 1MB', () => {
    expect(fmtSize(2048)).toBe('2.0K');
    expect(fmtSize(1536)).toBe('1.5K');
  });
  it('renders one-decimal MB at/above 1MB', () => {
    expect(fmtSize(1024 * 1024 * 3)).toBe('3.0M');
  });
});

describe('fmtAgo', () => {
  const now = 10_000_000_000;
  it('returns an empty string for a falsy timestamp', () => {
    expect(fmtAgo(0, now)).toBe('');
  });
  it('returns "just now" under a minute', () => {
    expect(fmtAgo(now - 30_000, now)).toBe('just now');
  });
  it('renders minutes / hours / days', () => {
    expect(fmtAgo(now - 5 * 60_000, now)).toBe('5m');
    expect(fmtAgo(now - 2 * 3_600_000, now)).toBe('2h');
    expect(fmtAgo(now - 3 * 86_400_000, now)).toBe('3d');
  });
});

describe('groupByTier', () => {
  it('buckets files into green/yellow/red preserving input order', () => {
    const files = [
      { path: 'a', tier: 'green' as const },
      { path: 'b', tier: 'red' as const },
      { path: 'c', tier: 'green' as const },
      { path: 'd', tier: 'yellow' as const },
    ];
    const g = groupByTier(files);
    expect(g.green.map((f) => f.path)).toEqual(['a', 'c']);
    expect(g.yellow.map((f) => f.path)).toEqual(['d']);
    expect(g.red.map((f) => f.path)).toEqual(['b']);
  });

  it('returns three empty buckets for no files', () => {
    expect(groupByTier([])).toEqual({ green: [], yellow: [], red: [] });
  });
});

describe('<MemoryBrowser />', () => {
  beforeEach(() => {
    artifactRows.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockMemoryFetch(files: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/memory-file')) {
          return { ok: true, json: async () => ({ content: '' }) } as unknown as Response;
        }
        return { ok: true, json: async () => ({ files }) } as unknown as Response;
      }),
    );
  }

  it('renders the file count and tier section headers from the /memory list', async () => {
    mockMemoryFetch([
      { path: 'memory/notes.md', tier: 'green', purpose: 'safe notes', language: 'markdown', exists: true, size: 100, mtimeMs: 0, writtenBy: [], readBy: [], editable: true, locked: false },
      { path: 'memory/state.json', tier: 'red', purpose: 'locked state', language: 'json', exists: true, size: 50, mtimeMs: 0, writtenBy: [], readBy: [], editable: false, locked: true },
    ]);
    render(<MemoryBrowser slug="h" alive={false} />);
    // "Memory map" header + the count badge (· 2) appear once the list loads.
    await waitFor(() => expect(screen.getByText('Memory map')).toBeTruthy());
    expect(screen.getByText(/Safe — edit anytime/)).toBeTruthy();
    expect(screen.getByText(/Locked while harness is running/)).toBeTruthy();
  });

  it('shows the running-harness warning badge when alive', async () => {
    mockMemoryFetch([]);
    render(<MemoryBrowser slug="h" alive />);
    await waitFor(() => expect(screen.getByText(/harness running/)).toBeTruthy());
  });

  function mdFile(over: Record<string, unknown> = {}) {
    return {
      path: 'memory/notes.md', tier: 'green', purpose: 'safe notes', language: 'markdown',
      exists: true, size: 100, mtimeMs: 0, writtenBy: ['orchestrator'], readBy: ['reviewer'],
      editable: true, locked: false, ...over,
    };
  }

  it('clicking a file row selects it and loads its content from the text-artifacts sync map (no extra fetch)', async () => {
    artifactRows.push({ harnessSlug: 'h', relPath: 'memory/notes.md', content: 'hello world', updatedAt: 1 });
    mockMemoryFetch([mdFile()]);
    render(<MemoryBrowser slug="h" alive={false} />);
    // Auto-selected first existing file → its content surfaces in the (stubbed) editor.
    await waitFor(() => expect((screen.getByTestId('md-editor') as HTMLTextAreaElement).value).toBe('hello world'));
    // The editor header echoes the active path + the written-by / read-by props strip.
    expect(screen.getAllByText('memory/notes.md').length).toBeGreaterThan(0);
    expect(screen.getByText('orchestrator')).toBeTruthy();
    expect(screen.getByText('reviewer')).toBeTruthy();
  });

  it('editing makes the doc dirty (enables save), and revert restores the original', async () => {
    artifactRows.push({ harnessSlug: 'h', relPath: 'memory/notes.md', content: 'orig', updatedAt: 1 });
    mockMemoryFetch([mdFile()]);
    render(<MemoryBrowser slug="h" alive={false} />);
    const editor = await screen.findByTestId('md-editor') as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('orig'));
    const saveBtn = screen.getByText('save') as HTMLButtonElement;
    const revertBtn = screen.getByText('revert') as HTMLButtonElement;
    // Clean state: both disabled.
    expect(saveBtn.disabled).toBe(true);
    expect(revertBtn.disabled).toBe(true);
    // Edit → dirty → both enabled.
    fireEvent.change(editor, { target: { value: 'changed' } });
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    expect(revertBtn.disabled).toBe(false);
    // Revert restores the original and re-disables.
    fireEvent.click(revertBtn);
    await waitFor(() => expect((screen.getByTestId('md-editor') as HTMLTextAreaElement).value).toBe('orig'));
    expect((screen.getByText('save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('save PUTs the active path + draft and shows the "saved" toast on success', async () => {
    artifactRows.push({ harnessSlug: 'h', relPath: 'memory/notes.md', content: 'orig', updatedAt: 1 });
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/memory-file') && init?.method === 'PUT') {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ files: [mdFile()] }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<MemoryBrowser slug="h" alive={false} />);
    const editor = await screen.findByTestId('md-editor') as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('orig'));
    fireEvent.change(editor, { target: { value: 'new content' } });
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(screen.getByText('saved')).toBeTruthy());
    // The PUT carried the path + the edited draft.
    const putCall = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
    expect(putCall).toBeTruthy();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({ path: 'memory/notes.md', content: 'new content' });
  });

  it('save surfaces the server error message when the PUT responds non-OK (body.error)', async () => {
    artifactRows.push({ harnessSlug: 'h', relPath: 'memory/notes.md', content: 'orig', updatedAt: 1 });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/memory-file') && init?.method === 'PUT') {
        return { ok: false, status: 409, json: async () => ({ error: 'file is locked' }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ files: [mdFile()] }) } as unknown as Response;
    }));
    render(<MemoryBrowser slug="h" alive={false} />);
    const editor = await screen.findByTestId('md-editor') as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('orig'));
    fireEvent.change(editor, { target: { value: 'x' } });
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(screen.getByText(/save failed: file is locked/)).toBeTruthy());
  });

  it('a locked file forces the editor read-only and keeps save disabled even when dirty would otherwise enable it', async () => {
    // Locked file (red tier). Editing is blocked: the editor is readOnly and save stays disabled.
    artifactRows.push({ harnessSlug: 'h', relPath: 'memory/state.json', content: '{}', updatedAt: 1 });
    mockMemoryFetch([mdFile({ path: 'memory/state.json', tier: 'red', language: 'json', locked: true, purpose: 'locked state' })]);
    render(<MemoryBrowser slug="h" alive />);
    // Non-markdown → Monaco stub. Wait for it to mount with the loaded content.
    const editor = await screen.findByTestId('monaco') as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('{}'));
    // Even after an edit, save stays disabled — the gate ANDs `!activeFile.locked`.
    fireEvent.change(editor, { target: { value: '{"a":1}' } });
    expect((screen.getByText('save') as HTMLButtonElement).disabled).toBe(true);
    // The header shows the locked banner.
    expect(screen.getByText(/locked — stop harness to edit/)).toBeTruthy();
  });
});
