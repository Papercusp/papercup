// @vitest-environment jsdom
/**
 * StepKeys.test.tsx — render-tier coverage for the SetupWizard "API keys" step.
 * Drives the /api/credentials GET (masked-key load) and the POST save flow
 * (success + error). useLexicon + RouteLink are stubbed so the brand-pack hook
 * and the router-compat link chain stay out of jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const syncFixture = vi.hoisted(() => ({
  rows: [{ memoryEmbedderMode: 'harrier' }],
  invalidate: vi.fn(),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: syncFixture.rows,
    loading: false,
    error: null,
    invalidate: syncFixture.invalidate,
  }),
}));

vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string, opts?: { plural?: boolean; lower?: boolean }) => {
    const base = key === 'pot' ? (opts?.plural ? 'Pots' : 'Pot') : key;
    return opts?.lower ? base.toLowerCase() : base;
  },
}));
vi.mock('../RouteLink', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { StepKeys } from './StepKeys';

/* fetch router for /api/credentials. credsBody → GET; POST records body and
 * replies either ok (echoing a new mask) or, when postFails, a 500. */
let credsBody: unknown;
let postFails: boolean;
let posts: unknown[];
function installFetch() {
  posts = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (postFails) return new Response('err', { status: 500 });
      return new Response(JSON.stringify({ openai_api_key: 'sk-***last' }), { status: 200 });
    }
    return new Response(JSON.stringify(credsBody), { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  credsBody = { openai_api_key: null };
  postFails = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepKeys (SetupWizard API-keys step)', () => {
  it('renders the alpha warning banner and both key cards', async () => {
    installFetch();
    render(<StepKeys />);
    expect(screen.getByText(/This app is alpha\./i)).toBeTruthy();
    expect(screen.getByText(/OpenAI — embeddings/i)).toBeTruthy();
    expect(screen.getByText(/ElevenLabs — voice/i)).toBeTruthy();
    // The memory-system chooser is the one required memory step; it defaults to
    // Harrier so no cloud key is needed (owner ask 2026-07-10; P-015 flip).
    expect(screen.getByText('Memory system')).toBeTruthy();
    expect(screen.getByText(/Harrier-OSS-0\.6b \(recommended\)/)).toBeTruthy();
    expect(screen.getByText('Required')).toBeTruthy();
    // Both key cards are now optional (memory no longer requires a cloud key).
    expect(screen.getAllByText('Optional').length).toBeGreaterThan(0);
  });

  it('defaults the memory system to Harrier and offers Gemma/BGE/OpenAI/off', async () => {
    installFetch();
    render(<StepKeys />);
    // pc-radio-card buttons (design-primitives lint: no native radio inputs) —
    // query by role + accessible name; checked-ness lives on aria-checked.
    const harrier = await screen.findByRole('radio', { name: /Harrier-OSS-0\.6b/ });
    expect(harrier.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /EmbeddingGemma-300m/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /BGE-small/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /OpenAI text-embedding-3-small/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /No persistent memory/ })).toBeTruthy();
  });

  it('shows the "Save" button label and no saved-mask chip when no key is stored', async () => {
    installFetch();
    render(<StepKeys />);
    // The input is enabled once loaded resolves.
    await waitFor(() => {
      const input = screen.getByPlaceholderText('sk-…') as HTMLInputElement;
      expect(input.disabled).toBe(false);
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByText(/^saved:/)).toBeNull();
  });

  it('shows the saved mask + "Replace" label when a key is already stored', async () => {
    credsBody = { openai_api_key: 'sk-***abcd' };
    installFetch();
    render(<StepKeys />);
    expect(await screen.findByText(/saved: sk-\*\*\*abcd/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
    expect(screen.getByPlaceholderText('paste a new key to replace')).toBeTruthy();
  });

  it('Save button is disabled until the input is non-empty', async () => {
    installFetch();
    render(<StepKeys />);
    await waitFor(() => expect((screen.getByPlaceholderText('sk-…') as HTMLInputElement).disabled).toBe(false));
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-newkey' } });
    expect(save.disabled).toBe(false);
  });

  it('saving a key POSTs the trimmed value, shows "Saved.", and clears the input', async () => {
    installFetch();
    render(<StepKeys />);
    await waitFor(() => expect((screen.getByPlaceholderText('sk-…') as HTMLInputElement).disabled).toBe(false));
    const input = screen.getByPlaceholderText('sk-…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  sk-trim  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect((posts[0] as { openai_api_key: string }).openai_api_key).toBe('sk-trim');
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(input.value).toBe('');
    // The echoed mask now renders, so the button flips to "Replace".
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
  });

  it('shows the failure hint when the save POST errors', async () => {
    postFails = true;
    installFetch();
    render(<StepKeys />);
    await waitFor(() => expect((screen.getByPlaceholderText('sk-…') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Save failed — try again\./i)).toBeTruthy();
  });
});
