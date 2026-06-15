// @vitest-environment jsdom
//
// PromptsTab — the per-harness prompt-override editor (global read-only base vs
// project override, two grouped sidebars). The role-keying derivation
// (`overrideMapFromArtifacts`, which parses `prompts/<role>.md` artifact keys) is
// extracted + tested; a render-smoke drives the sidebar with a mocked /prompts
// list fetch + a mocked text-artifacts subscription. The MarkdownEditor and the
// save shortcut are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../_components/MarkdownEditor', () => ({
  MarkdownEditor: () => <div data-testid="md-editor" />,
}));
vi.mock('../../lib/hotkeys', () => ({ useShortcut: () => {} }));
vi.mock('sonner', () => ({ toast: { error: () => {}, success: () => {} } }));
vi.mock('./Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const { artifacts } = vi.hoisted(() => ({ artifacts: { rows: [] as unknown[] } }));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: artifacts.rows, loading: false, error: null }),
}));

import PromptsTab, { overrideMapFromArtifacts } from './PromptsTab';

afterEach(() => {
  cleanup();
  artifacts.rows = [];
});

describe('overrideMapFromArtifacts', () => {
  it('keys prompts/<role>.md rows by their role', () => {
    const m = overrideMapFromArtifacts([
      { relPath: 'prompts/orchestrator.md', content: 'O' },
      { relPath: 'prompts/reviewer.md', content: 'R' },
    ]);
    expect(m.get('orchestrator')).toBe('O');
    expect(m.get('reviewer')).toBe('R');
    expect(m.size).toBe(2);
  });

  it('ignores artifact rows that are not under prompts/', () => {
    const m = overrideMapFromArtifacts([
      { relPath: 'memory/notes.md', content: 'x' },
      { relPath: 'prompts/coder.md', content: 'C' },
    ]);
    expect(m.size).toBe(1);
    expect(m.get('coder')).toBe('C');
  });

  it('handles a role name with dots/slashes in the captured group', () => {
    const m = overrideMapFromArtifacts([{ relPath: 'prompts/sub.role.md', content: 'S' }]);
    expect(m.get('sub.role')).toBe('S');
  });

  it('returns an empty map for a non-array (un-hydrated) subscription', () => {
    expect(overrideMapFromArtifacts(undefined).size).toBe(0);
  });

  it('defaults missing content to an empty string', () => {
    const m = overrideMapFromArtifacts([{ relPath: 'prompts/x.md' }]);
    expect(m.get('x')).toBe('');
  });
});

describe('<PromptsTab />', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (typeof url === 'string' && /\/prompts$/.test(url)) {
          return { ok: true, json: async () => ({ roles: ['orchestrator', 'reviewer'], overrides: ['reviewer'] }) } as unknown as Response;
        }
        // Per-role global fetch.
        return { ok: true, json: async () => ({ globalContent: 'base', content: '', overrideExists: false }) } as unknown as Response;
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists roles under both Global and Project-overrides sidebars', async () => {
    render(<PromptsTab slug="h" alive={false} />);
    await waitFor(() => expect(screen.getAllByText('orchestrator').length).toBeGreaterThan(0));
    // Each role appears in BOTH sidebar sections (global + override); the
    // default-selected role (orchestrator) also shows in the editor header.
    expect(screen.getAllByText('orchestrator').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('reviewer').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Global (read-only)')).toBeTruthy();
    // The override section header carries the override count (· 1).
    expect(screen.getByText(/Project overrides · 1/)).toBeTruthy();
  });
});
