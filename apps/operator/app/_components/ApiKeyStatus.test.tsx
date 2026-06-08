// @vitest-environment jsdom
/**
 * Tests for <ApiKeyStatus> — the header pill that reads /api/credentials and
 * renders the Anthropic-key dot + a composed label of which optional keys
 * (OpenAI / GitHub) are also present.
 *
 * Focus is the label/dot composition + the loading/failure fallbacks:
 *  - before the fetch settles (and on a non-ok / rejected fetch) → "checking…";
 *  - Anthropic set → green dot + "Anthropic key set" with the optional keys
 *    appended in order;
 *  - Anthropic missing → warn dot + "Anthropic key not set".
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
/** The dot's background color (the second inline span). */
function dotColor(): string | undefined {
  return (document.querySelector('span > span[aria-hidden]') as HTMLElement | null)?.style.background;
}

describe('ApiKeyStatus', () => {
  it('shows "checking…" until the fetch resolves', () => {
    mockFetch.mockReturnValue(new Promise<Response>(() => {})); // never resolves
    render(<ApiKeyStatus />);
    expect(screen.getByText('checking…')).toBeTruthy();
  });

  it('shows a green dot + "Anthropic key set" when the Anthropic key is present', async () => {
    mockFetch.mockResolvedValue(okJson(creds({ anthropic_api_key: 'sk-ant' })));
    render(<ApiKeyStatus />);
    expect(await screen.findByText('Anthropic key set')).toBeTruthy();
    expect(dotColor()).toContain('var(--good)');
  });

  it('appends the optional keys that are set, in order (OpenAI · GitHub)', async () => {
    mockFetch.mockResolvedValue(
      okJson(creds({ anthropic_api_key: 'a', openai_api_key: 'o', github_pat: 'g' })),
    );
    render(<ApiKeyStatus />);
    expect(await screen.findByText('Anthropic key set · OpenAI · GitHub')).toBeTruthy();
  });

  it('lists only the optional keys that are actually set', async () => {
    mockFetch.mockResolvedValue(okJson(creds({ anthropic_api_key: 'a', github_pat: 'g' })));
    render(<ApiKeyStatus />);
    expect(await screen.findByText('Anthropic key set · GitHub')).toBeTruthy();
  });

  it('shows a warn dot + "Anthropic key not set" when the Anthropic key is missing', async () => {
    mockFetch.mockResolvedValue(okJson(creds({ openai_api_key: 'o' })));
    render(<ApiKeyStatus />);
    expect(await screen.findByText('Anthropic key not set')).toBeTruthy();
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
