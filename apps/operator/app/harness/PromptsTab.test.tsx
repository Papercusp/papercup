// @vitest-environment jsdom
//
// PromptsTab — the per-harness prompt-override editor (global read-only base vs
// project override, two grouped sidebars). The role-keying derivation
// (`overrideMapFromArtifacts`, which parses `prompts/<role>.md` artifact keys) is
// extracted + tested; a render-smoke drives the sidebar with a mocked /prompts
// list fetch + a mocked text-artifacts subscription. The MarkdownEditor and the
// save shortcut are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../_components/MarkdownEditor', () => ({
  // Forward value/onChange + readOnly so tests can read the editor content,
  // drive edits (the dirty gate behind save), and assert the global read-only branch.
  MarkdownEditor: ({ value, onChange, readOnly }: { value?: string; onChange?: (v: string) => void; readOnly?: boolean }) => (
    <textarea data-testid="md-editor" data-readonly={readOnly ? 'true' : 'false'} value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));
vi.mock('../../lib/hotkeys', () => ({ useShortcut: () => {} }));

const { toastSpies, confirmState } = vi.hoisted(() => ({
  toastSpies: { error: vi.fn(), success: vi.fn() },
  confirmState: { answer: true },
}));
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastSpies.error(m), success: (m: string) => toastSpies.success(m) } }));
vi.mock('./Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./useConfirmDialog', () => ({
  // Resolve the confirm to whatever confirmState.answer holds; no real dialog.
  useConfirmDialog: () => ({ confirm: async () => confirmState.answer, element: null }),
}));

const { artifacts } = vi.hoisted(() => ({ artifacts: { rows: [] as unknown[] } }));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: artifacts.rows, loading: false, error: null }),
}));

import PromptsTab, { overrideMapFromArtifacts } from './PromptsTab';

afterEach(() => {
  cleanup();
  artifacts.rows = [];
  toastSpies.error.mockClear();
  toastSpies.success.mockClear();
  confirmState.answer = true;
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
  /** Default fetch: a roles list + a per-role global fetch. PUT/DELETE/POST are
   *  routed by method so individual tests can assert the mutation calls. */
  function installFetch(over?: (url: string, init?: RequestInit) => Response | undefined) {
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      const custom = over?.(url, init);
      if (custom) return custom;
      if (typeof url === 'string' && /\/prompts$/.test(url)) {
        return { ok: true, json: async () => ({ roles: ['orchestrator', 'reviewer'], overrides: ['reviewer'] }) } as unknown as Response;
      }
      // Per-role global fetch (GET).
      return { ok: true, json: async () => ({ globalContent: 'base', content: '', overrideExists: false }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  beforeEach(() => { installFetch(); });
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

  it('defaults to orchestrator/global with a read-only editor showing the global base', async () => {
    render(<PromptsTab slug="h" alive={false} />);
    const editor = await screen.findByTestId('md-editor') as HTMLTextAreaElement;
    // Global scope: editor is read-only and shows the global base content.
    await waitFor(() => expect(editor.value).toBe('base'));
    expect(editor.getAttribute('data-readonly')).toBe('true');
    // The global read-only banner + badge are present; no save button on global scope.
    expect(screen.getByText(/global · read-only/)).toBeTruthy();
    expect(screen.queryByText('save')).toBeNull();
  });

  // The default-selection effect (orchestrator/global) commits a tick after the
  // sidebar renders; clicking a row before it settles is clobbered by that
  // effect's setSelected. Gate every interaction on the editor showing the
  // global base ("base") first — that's the signal the default selection landed.
  async function waitForDefaultSelection() {
    await waitFor(() => expect((screen.getByTestId('md-editor') as HTMLTextAreaElement).value).toBe('base'));
  }
  function clickOverrideRow(role: string) {
    // The role text can also appear in the editor header (no button ancestor);
    // keep only sidebar occurrences (inside a <button>) and take the override one
    // (the last sidebar button — Global section renders before Project overrides).
    const buttons = screen
      .getAllByText(role)
      .map((el) => el.closest('button'))
      .filter((b): b is HTMLButtonElement => !!b);
    fireEvent.click(buttons[buttons.length - 1]);
  }

  it('selecting the override scope shows an editable editor and a save button', async () => {
    artifacts.rows = [{ relPath: 'prompts/orchestrator.md', content: 'my override' }];
    render(<PromptsTab slug="h" alive={false} />);
    await waitForDefaultSelection();
    clickOverrideRow('orchestrator');
    const editor = screen.getByTestId('md-editor') as HTMLTextAreaElement;
    // Override scope: editor editable, seeded from the sync-map override content.
    await waitFor(() => expect(editor.getAttribute('data-readonly')).toBe('false'));
    expect(editor.value).toBe('my override');
    expect(screen.getByText('save')).toBeTruthy();
  });

  it('editing an override enables save; saving PUTs the draft and toasts success', async () => {
    const spy = installFetch();
    render(<PromptsTab slug="h" alive={false} />);
    await waitForDefaultSelection();
    clickOverrideRow('reviewer'); // override scope
    const editor = screen.getByTestId('md-editor') as HTMLTextAreaElement;
    await waitFor(() => expect(editor.getAttribute('data-readonly')).toBe('false'));
    const saveBtn = screen.getByText('save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true); // clean
    fireEvent.change(editor, { target: { value: 'edited override' } });
    await waitFor(() => expect((screen.getByText('save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(toastSpies.success).toHaveBeenCalledWith('saved reviewer override'));
    const put = spy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
    expect(put).toBeTruthy();
    expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({ content: 'edited override' });
    expect((put![0] as string)).toContain('/prompts/reviewer');
  });

  it('a failed save surfaces the server error text from r.text()', async () => {
    installFetch((url, init) => {
      if (init?.method === 'PUT') {
        return { ok: false, status: 500, text: async () => 'disk full' } as unknown as Response;
      }
      return undefined;
    });
    render(<PromptsTab slug="h" alive={false} />);
    await waitForDefaultSelection();
    clickOverrideRow('reviewer');
    const editor = screen.getByTestId('md-editor') as HTMLTextAreaElement;
    await waitFor(() => expect(editor.getAttribute('data-readonly')).toBe('false'));
    fireEvent.change(editor, { target: { value: 'x' } });
    fireEvent.click(await screen.findByText('save'));
    await waitFor(() => expect(toastSpies.error).toHaveBeenCalledWith('save failed: disk full'));
  });

  it('reset-to-default deletes the override after confirm and toasts success', async () => {
    // Selected reviewer override already exists (overrideExists from sync map).
    artifacts.rows = [{ relPath: 'prompts/reviewer.md', content: 'existing' }];
    const spy = installFetch();
    render(<PromptsTab slug="h" alive={false} />);
    await waitForDefaultSelection();
    clickOverrideRow('reviewer');
    // The reset-to-default button appears because the override exists.
    const resetBtn = await screen.findByText('reset to default');
    fireEvent.click(resetBtn);
    await waitFor(() => expect(toastSpies.success).toHaveBeenCalledWith('reset reviewer to default'));
    expect(spy.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true);
  });

  it('reset-to-default is a no-op when the confirm is declined (no DELETE)', async () => {
    confirmState.answer = false;
    artifacts.rows = [{ relPath: 'prompts/reviewer.md', content: 'existing' }];
    const spy = installFetch();
    render(<PromptsTab slug="h" alive={false} />);
    await waitForDefaultSelection();
    clickOverrideRow('reviewer');
    fireEvent.click(await screen.findByText('reset to default'));
    // Give the declined confirm a tick; no DELETE should fire.
    await waitFor(() => expect(toastSpies.success).not.toHaveBeenCalled());
    expect(spy.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('reset-all POSTs to /reset-all after confirm and reports the cleared count', async () => {
    const spy = installFetch((url, init) => {
      if (typeof url === 'string' && url.endsWith('/prompts/reset-all') && init?.method === 'POST') {
        return { ok: true, json: async () => ({ cleared: 3 }) } as unknown as Response;
      }
      return undefined;
    });
    render(<PromptsTab slug="h" alive={false} />);
    // "reset all" lives in the override-section header (overrides.length > 0).
    const resetAllBtn = await screen.findByText('reset all');
    fireEvent.click(resetAllBtn);
    await waitFor(() => expect(toastSpies.success).toHaveBeenCalledWith('reset 3 overrides to default'));
    expect(spy.mock.calls.some((c) => typeof c[0] === 'string' && (c[0] as string).endsWith('/reset-all'))).toBe(true);
  });

  it('shows the running-harness warning banner on the override scope when alive', async () => {
    render(<PromptsTab slug="h" alive />);
    await waitForDefaultSelection();
    clickOverrideRow('reviewer');
    await waitFor(() => expect(screen.getByText(/harness is running/)).toBeTruthy());
  });
});
