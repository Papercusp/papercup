// @vitest-environment jsdom
/**
 * GlobalSearchDialog (Mod+Shift+F global content search) — renders hits from
 * the public fulltext endpoint; the ts_headline <b> markers become <mark>
 * (and ONLY them — no raw-HTML injection).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import GlobalSearchDialog, { renderHighlight } from './GlobalSearchDialog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function envelope(results: unknown[]) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ query: 'voice', scope: ['all'], total_hits: results.length, results }),
          },
        ],
      }),
  } as Response;
}

describe('GlobalSearchDialog', () => {
  it('fetches the fulltext endpoint (debounced) and renders hits with <mark> highlights', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        envelope([
          {
            source: 'plans',
            source_id: 'universal-voice-interface-2026-06-05',
            harness_slug: 'all',
            excerpt: 'the voice bus',
            highlight: 'the <b>voice</b> bus',
          },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <NuqsTestingAdapter searchParams="?gsearch=true&gq=voice">
        <GlobalSearchDialog />
      </NuqsTestingAdapter>,
    );

    const hit = await waitFor(() => screen.getByTestId('gsearch-hit'), { timeout: 3000 });
    expect(hit.textContent).toContain('plans');
    expect(hit.textContent).toContain('the voice bus');
    // The match is a real <mark>, not injected HTML.
    expect(hit.querySelector('mark')?.textContent).toBe('voice');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent-tools/search/fulltext',
      expect.objectContaining({ method: 'POST' }),
    );
    const rawInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(rawInit.body))).toEqual({ query: 'voice', limit: 10 });
  });

  it('does not fetch while closed or for <2-char queries', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <NuqsTestingAdapter searchParams="?gq=voice">
        <GlobalSearchDialog />
      </NuqsTestingAdapter>,
    );
    render(
      <NuqsTestingAdapter searchParams="?gsearch=true&gq=v">
        <GlobalSearchDialog />
      </NuqsTestingAdapter>,
    );
    await new Promise((r) => setTimeout(r, 450));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('renderHighlight', () => {
  it('turns <b> markers into <mark> and leaves other markup as inert text', () => {
    const nodes = renderHighlight('a <b>hit</b> & <script>alert(1)</script>');
    // Three segments: text, mark, text — the script tag stays a literal string.
    expect(nodes.length).toBe(3);
  });
});
