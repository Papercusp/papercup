// @vitest-environment jsdom
/**
 * Tests for <ApiKeyStatus> — a pill that reads /api/credentials and renders a
 * dot + label for whether the raw keys it still makes sense to require are set.
 *
 * ⚠ The component is NOT MOUNTED anywhere in the product (measured 2026-08-09; only this
 * test and the stories reference it). These tests therefore pin a component's contract,
 * not a user-visible surface.
 *
 * Re-keyed onto the OPENAI EMBEDDINGS key by
 * inference-rename-and-provider-agnostic-default-2026-08-09 P-004. It used to warn on a
 * missing ANTHROPIC key; that is no longer a gap, because Anthropic access comes from the
 * default account under Settings → Inference and a box with no Anthropic key is the normal
 * working configuration. Embeddings are what a subscription account cannot supply.
 *
 * Focus is the label/dot composition + the loading/failure fallbacks:
 *  - before the fetch settles (and on a non-ok / rejected fetch) → "checking…";
 *  - embeddings key set → green dot + "Embeddings key set" (+ GitHub when present);
 *  - embeddings key missing → warn dot + "OpenAI embeddings key not set".
 *
 * fetch is stubbed via vi.stubGlobal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ApiKeyStatus from './ApiKeyStatus';

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function creds(over: Partial<Record<'anthropic_api_key' | 'openai_api_key' | 'github_pat', string | null>> = {}) {
  return { anthropic_api_key: null, openai_api_key: null, github_pat: null, ...over };
}
/**
 * The dot's background color (the second inline span). Reads the `backgroundColor`
 * longhand — NOT the `background` shorthand: jsdom's cssstyle validates `var()` on
 * the shorthand inconsistently across versions and can drop it to '' (EI-10455's
 * flip-flake); the longhand preserves `var()` verbatim.
 */
function dotColor(): string | undefined {
  return (document.querySelector('span > span[aria-hidden]') as HTMLElement | null)?.style
    .backgroundColor;
}

describe('ApiKeyStatus', () => {
  it('shows "checking…" until the fetch resolves', () => {
    mockFetch.mockReturnValue(new Promise<Response>(() => {})); // never resolves
    render(<ApiKeyStatus />);
    expect(screen.getByText('checking…')).toBeTruthy();
  });

  it('shows a green dot + "Embeddings key set" when the OpenAI key is present', async () => {
    mockFetch.mockResolvedValue(okJson(creds({ openai_api_key: 'sk-oai' })));
    render(<ApiKeyStatus />);
    expect(await screen.findByText('Embeddings key set')).toBeTruthy();
    expect(dotColor()).toContain('var(--good)');
  });

  it('appends GitHub when that is set too', async () => {
    mockFetch.mockResolvedValue(okJson(creds({ openai_api_key: 'o', github_pat: 'g' })));
    render(<ApiKeyStatus />);
    expect(await screen.findByText('Embeddings key set · GitHub')).toBeTruthy();
  });

  it('shows a warn dot + "OpenAI embeddings key not set" when the OpenAI key is missing', async () => {
    mockFetch.mockResolvedValue(okJson(creds({ github_pat: 'g' })));
    render(<ApiKeyStatus />);
    expect(await screen.findByText('OpenAI embeddings key not set')).toBeTruthy();
    expect(dotColor()).toContain('var(--warn)');
  });

  it('does NOT treat a missing Anthropic key as a gap', async () => {
    // The regression guard for P-004. An Anthropic-less box is fully working now (the default
    // account serves it), so a green dot here is the correct reading — and an ANTHROPIC key
    // present with no embeddings key must NOT rescue it, which is what the second half pins.
    mockFetch.mockResolvedValue(okJson(creds({ anthropic_api_key: null, openai_api_key: 'o' })));
    render(<ApiKeyStatus />);
    expect(await screen.findByText('Embeddings key set')).toBeTruthy();
    expect(dotColor()).toContain('var(--good)');
    cleanup();

    mockFetch.mockResolvedValue(okJson(creds({ anthropic_api_key: 'sk-ant', openai_api_key: null })));
    render(<ApiKeyStatus />);
    expect(await screen.findByText('OpenAI embeddings key not set')).toBeTruthy();
    expect(dotColor()).toContain('var(--warn)');
  });

  it('stays "checking…" on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    render(<ApiKeyStatus />);
    // Let the effect's promise chain settle, then assert the fallback held.
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText('checking…')).toBeTruthy();
  });

  it('stays "checking…" when the fetch rejects', async () => {
    mockFetch.mockRejectedValue(new Error('network'));
    render(<ApiKeyStatus />);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText('checking…')).toBeTruthy();
  });
});
