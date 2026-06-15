// @vitest-environment jsdom
//
// SavedPromptsSection — the saved-prompts settings module (harness OR workspace
// scope). The pure gates (`scopeHarness`, `isValidPromptName`, `canSavePrompt`)
// are extracted + tested branch-by-branch; a render-smoke drives the list with a
// mocked saved-prompts client to confirm the empty / populated surfaces and the
// scope-note copy. nuqs + sonner are mocked (no URL, no toasts under test).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const { client } = vi.hoisted(() => ({
  client: { prompts: [] as unknown[] },
}));
vi.mock('@papercusp/operator-core/lib/saved-prompts-client', () => ({
  fetchSavedPrompts: async () => client.prompts,
  saveSavedPrompt: async () => ({}),
  deleteSavedPrompt: async () => {},
}));
vi.mock('sonner', () => ({ toast: { error: () => {}, success: () => {} } }));
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
});
