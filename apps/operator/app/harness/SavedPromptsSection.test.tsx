// @vitest-environment jsdom
//
// SavedPromptsSection — the saved-prompts settings module (harness OR workspace
// scope). The pure gates (`scopeHarness`, `isValidPromptName`, `canSavePrompt`)
// are extracted + tested branch-by-branch; a render-smoke drives the list with a
// mocked saved-prompts client to confirm the empty / populated surfaces and the
// scope-note copy. nuqs + sonner are mocked (no URL, no toasts under test).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { client, toastSpies } = vi.hoisted(() => ({
  client: {
    prompts: [] as unknown[],
    save: vi.fn(async () => ({})),
    del: vi.fn(async () => {}),
  },
  toastSpies: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@papercusp/operator-core/lib/saved-prompts-client', () => ({
  fetchSavedPrompts: async () => client.prompts,
  saveSavedPrompt: (input: unknown) => client.save(input as never),
  deleteSavedPrompt: (name: string, harness?: string | null) => client.del(name as never, harness as never),
}));
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastSpies.error(m), success: (m: string) => toastSpies.success(m) } }));
vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    useQueryState: () => React.useState<string | null>(null),
    parseAsString: {},
  };
});

import SavedPromptsSection, {
  scopeHarness,
  isValidPromptName,
  canSavePrompt,
} from './SavedPromptsSection';

afterEach(() => {
  cleanup();
  client.prompts = [];
  client.save.mockClear();
  client.save.mockResolvedValue({} as never);
  client.del.mockClear();
  client.del.mockResolvedValue(undefined as never);
  toastSpies.error.mockClear();
  toastSpies.success.mockClear();
});

describe('scopeHarness', () => {
  it('returns the slug for a harness scope', () => {
    expect(scopeHarness({ kind: 'harness', slug: 'my-h' })).toBe('my-h');
  });
  it('returns undefined for a workspace scope', () => {
    expect(scopeHarness({ kind: 'workspace' })).toBeUndefined();
  });
});

describe('isValidPromptName', () => {
  it('accepts lowercase alphanumeric + dashes', () => {
    expect(isValidPromptName('ship-it')).toBe(true);
    expect(isValidPromptName('a1')).toBe(true);
  });
  it('rejects uppercase, leading dash, spaces, and empty', () => {
    expect(isValidPromptName('Ship')).toBe(false);
    expect(isValidPromptName('-x')).toBe(false);
    expect(isValidPromptName('two words')).toBe(false);
    expect(isValidPromptName('')).toBe(false);
  });
});

describe('canSavePrompt', () => {
  it('is true with a valid name and non-blank body when not saving', () => {
    expect(canSavePrompt({ saving: false, name: 'ship-it', body: 'do it' })).toBe(true);
  });
  it('is false while saving', () => {
    expect(canSavePrompt({ saving: true, name: 'ship-it', body: 'do it' })).toBe(false);
  });
  it('is false for an invalid name', () => {
    expect(canSavePrompt({ saving: false, name: 'Bad Name', body: 'do it' })).toBe(false);
  });
  it('is false for a whitespace-only body', () => {
    expect(canSavePrompt({ saving: false, name: 'ship-it', body: '   ' })).toBe(false);
  });
});

describe('<SavedPromptsSection />', () => {
  it('shows the empty-state copy when there are no prompts', async () => {
    render(<SavedPromptsSection scope={{ kind: 'workspace' }} />);
    await waitFor(() => expect(screen.getByText(/no saved prompts yet/i)).toBeTruthy());
  });

  it('renders a row per prompt with its /name', async () => {
    client.prompts = [
      { id: '1', name: 'ship-it', description: 'ship the diff', body: 'b', argHint: null },
      { id: '2', name: 'review', description: null, body: 'b', argHint: null },
    ];
    render(<SavedPromptsSection scope={{ kind: 'harness', slug: 'h' }} />);
    await waitFor(() => expect(screen.getByText('/ship-it')).toBeTruthy());
    expect(screen.getByText('/review')).toBeTruthy();
    expect(screen.getByText('ship the diff')).toBeTruthy();
  });

  it('shows the harness-scope note for a harness scope', async () => {
    render(<SavedPromptsSection scope={{ kind: 'harness', slug: 'h' }} />);
    await waitFor(() => expect(screen.getByText(/written to its repo at .claude\/commands/i)).toBeTruthy());
  });

  it('shows the workspace-scope note for a workspace scope', async () => {
    render(<SavedPromptsSection scope={{ kind: 'workspace' }} />);
    await waitFor(() => expect(screen.getByText(/available across every harness/i)).toBeTruthy());
  });

  it('opens the create editor and keeps Save disabled until a valid name + non-blank body', async () => {
    render(<SavedPromptsSection scope={{ kind: 'workspace' }} />);
    await waitFor(() => expect(screen.getByText(/no saved prompts yet/i)).toBeTruthy());
    fireEvent.click(screen.getByText('+ New prompt'));
    // Editor opened: the name field appears.
    const name = screen.getByPlaceholderText('ship-it') as HTMLInputElement;
    const body = screen.getByPlaceholderText(/review the diff for/i) as HTMLTextAreaElement;
    const saveBtn = screen.getByText('Save') as HTMLButtonElement;
    // Fresh editor: empty name + empty body → Save disabled.
    expect(saveBtn.disabled).toBe(true);
    // Valid name but still-blank body → still disabled.
    fireEvent.change(name, { target: { value: 'ship-it' } });
    expect(saveBtn.disabled).toBe(true);
    // Add a body → Save enabled.
    fireEvent.change(body, { target: { value: 'do it' } });
    expect(saveBtn.disabled).toBe(false);
  });

  it('surfaces the invalid-name hint and keeps Save disabled for a bad name', async () => {
    render(<SavedPromptsSection scope={{ kind: 'workspace' }} />);
    await waitFor(() => expect(screen.getByText(/no saved prompts yet/i)).toBeTruthy());
    fireEvent.click(screen.getByText('+ New prompt'));
    const name = screen.getByPlaceholderText('ship-it') as HTMLInputElement;
    const body = screen.getByPlaceholderText(/review the diff for/i) as HTMLTextAreaElement;
    fireEvent.change(name, { target: { value: 'Bad Name' } });
    fireEvent.change(body, { target: { value: 'do it' } });
    // Validation hint shows; Save remains disabled despite a non-blank body.
    expect(screen.getByText(/lowercase letters, digits and dashes only/i)).toBeTruthy();
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Save calls saveSavedPrompt with the scoped harness + trimmed optional fields, then closes the editor', async () => {
    render(<SavedPromptsSection scope={{ kind: 'harness', slug: 'my-h' }} />);
    await waitFor(() => expect(screen.getByText(/written to its repo/i)).toBeTruthy());
    fireEvent.click(screen.getByText('+ New prompt'));
    fireEvent.change(screen.getByPlaceholderText('ship-it'), { target: { value: 'ship-it' } });
    fireEvent.change(screen.getByPlaceholderText(/review the diff for/i), { target: { value: 'body text' } });
    // Optional fields with surrounding whitespace → trimmed (or nulled when blank).
    fireEvent.change(screen.getByPlaceholderText('Review the diff and ship if green'), { target: { value: '  desc  ' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(1));
    expect(client.save).toHaveBeenCalledWith({
      harness: 'my-h',
      name: 'ship-it',
      body: 'body text',
      description: 'desc',
      argHint: null,
    });
    expect(toastSpies.success).toHaveBeenCalledWith('Saved /ship-it');
    // Editor closed after a successful save → the New-prompt button is back.
    await waitFor(() => expect(screen.getByText('+ New prompt')).toBeTruthy());
  });

  it('toasts the error and leaves the editor open when saveSavedPrompt rejects', async () => {
    client.save.mockRejectedValueOnce(new Error('boom') as never);
    render(<SavedPromptsSection scope={{ kind: 'workspace' }} />);
    await waitFor(() => expect(screen.getByText(/no saved prompts yet/i)).toBeTruthy());
    fireEvent.click(screen.getByText('+ New prompt'));
    fireEvent.change(screen.getByPlaceholderText('ship-it'), { target: { value: 'ship-it' } });
    fireEvent.change(screen.getByPlaceholderText(/review the diff for/i), { target: { value: 'b' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(toastSpies.error).toHaveBeenCalledWith('boom'));
    // Editor still open (Save button still visible) since the save failed.
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('Cancel closes the editor without calling the client', async () => {
    render(<SavedPromptsSection scope={{ kind: 'workspace' }} />);
    await waitFor(() => expect(screen.getByText(/no saved prompts yet/i)).toBeTruthy());
    fireEvent.click(screen.getByText('+ New prompt'));
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.getByText('+ New prompt')).toBeTruthy());
    expect(client.save).not.toHaveBeenCalled();
  });

  it('Edit opens the editor seeded from the row and disables the (slash-command) name field', async () => {
    client.prompts = [
      { id: '1', name: 'ship-it', description: 'd', body: 'the body', argHint: '<area>' },
    ];
    render(<SavedPromptsSection scope={{ kind: 'workspace' }} />);
    await waitFor(() => expect(screen.getByText('/ship-it')).toBeTruthy());
    fireEvent.click(screen.getByText('Edit'));
    const name = screen.getByPlaceholderText('ship-it') as HTMLInputElement;
    const body = screen.getByPlaceholderText(/review the diff for/i) as HTMLTextAreaElement;
    expect(name.value).toBe('ship-it');
    expect(body.value).toBe('the body');
    // Name is immutable when editing an existing prompt (it's the command key).
    expect(name.disabled).toBe(true);
  });

  it('delete is a two-click confirm: first click arms "Confirm?", second click deletes', async () => {
    client.prompts = [
      { id: '1', name: 'ship-it', description: null, body: 'b', argHint: null },
    ];
    render(<SavedPromptsSection scope={{ kind: 'harness', slug: 'h' }} />);
    await waitFor(() => expect(screen.getByText('/ship-it')).toBeTruthy());
    const delBtn = screen.getByText('Delete');
    // First click arms confirmation, does NOT call the client.
    fireEvent.click(delBtn);
    expect(client.del).not.toHaveBeenCalled();
    expect(screen.getByText('Confirm?')).toBeTruthy();
    // Second click performs the delete with the row name + scoped harness.
    fireEvent.click(screen.getByText('Confirm?'));
    await waitFor(() => expect(client.del).toHaveBeenCalledWith('ship-it', 'h'));
    expect(toastSpies.success).toHaveBeenCalledWith('Deleted /ship-it');
  });

  it('blurring the armed delete button disarms it (no accidental delete)', async () => {
    client.prompts = [
      { id: '1', name: 'ship-it', description: null, body: 'b', argHint: null },
    ];
    render(<SavedPromptsSection scope={{ kind: 'workspace' }} />);
    await waitFor(() => expect(screen.getByText('/ship-it')).toBeTruthy());
    const delBtn = screen.getByText('Delete');
    fireEvent.click(delBtn);
    expect(screen.getByText('Confirm?')).toBeTruthy();
    fireEvent.blur(screen.getByText('Confirm?'));
    // Back to the disarmed label, no client call.
    await waitFor(() => expect(screen.getByText('Delete')).toBeTruthy());
    expect(client.del).not.toHaveBeenCalled();
  });
});
