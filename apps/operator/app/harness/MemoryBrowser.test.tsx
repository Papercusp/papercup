// @vitest-environment jsdom
//
// MemoryBrowser — the per-harness memory-map file editor. The format helpers
// (`fmtSize`, `fmtAgo`) and the tier grouping (`groupByTier`) are extracted +
// tested branch-by-branch; a render-smoke drives the left-rail grouping with a
// mocked /memory fetch + a mocked text-artifacts sync subscription. Monaco /
// MarkdownEditor / the save-shortcut are stubbed (out of scope, jsdom-hostile).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// Monaco references browser layout APIs jsdom lacks; the editor isn't under
// test, so a marker stand-in keeps the smoke clean.
vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco" />,
}));
vi.mock('../_components/MarkdownEditor', () => ({
  MarkdownEditor: () => <div data-testid="md-editor" />,
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
});
