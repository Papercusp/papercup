// @vitest-environment jsdom
/**
 * The index's Instructions loader, EXECUTED — not just string-matched.
 *
 * [owner 2026-09-28, #868] "the instructions should come seperate from the release
 * cut": the index no longer carries the text; it loads instructions.html at view
 * time. The whole feature is that one script working against that one page, so this
 * runs the script the index actually ships against the page the instructions CLI
 * actually renders, and checks the failure modes leave the no-JS link in place.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// release-history-page imports only `releaseHistoryStem` from this module, which
// also imports esbuild — and esbuild refuses to load under jsdom (its TextEncoder
// invariant). An empty release list never calls it; the stub just keeps esbuild out.
vi.mock('./release-project-history', () => ({
  releaseHistoryStem: (version: string, channel: string) => `desktop-v${version}-${channel}`,
}));

import {
  INSTRUCTIONS_BODY_ID,
  INSTRUCTIONS_LOADER_ATTR,
  INSTRUCTIONS_PAGE_PATH,
  renderIndexHtml,
  renderInstructionsHtml,
} from './release-history-page';

const GENERATED_AT = new Date('2026-09-28T00:00:00Z');
const index = renderIndexHtml([], { generatedAt: GENERATED_AT, analytics: null, redact: [] });
const page = renderInstructionsHtml({ generatedAt: GENERATED_AT, redact: [] });

/** Mount the index body and run its loader exactly as a browser would. */
function mountAndRunLoader(fetchImpl: typeof fetch): HTMLElement {
  const doc = new DOMParser().parseFromString(index, 'text/html');
  document.body.replaceWith(document.importNode(doc.body, true));
  const loader = document.querySelector(`script[${INSTRUCTIONS_LOADER_ATTR}]`);
  expect(loader, 'the index must ship the loader').not.toBeNull();
  vi.stubGlobal('fetch', fetchImpl);
  new Function(loader!.textContent ?? '')();
  return document.getElementById(INSTRUCTIONS_BODY_ID)!;
}

const noJsLink = `<a href="${INSTRUCTIONS_PAGE_PATH}">Read the setup instructions</a>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Instructions loader on the release index [owner #868]', () => {
  it('fills the section from the separately published instructions.html', async () => {
    const fetchSpy = vi.fn(async () => new Response(page, { status: 200 }));
    const box = mountAndRunLoader(fetchSpy as unknown as typeof fetch);
    await vi.waitFor(() => expect(box.innerHTML).toContain('<strong>Install both apps</strong>'));
    expect(box.innerHTML).toContain('Agent modes');
    expect(box.innerHTML).not.toContain('Read the setup instructions');
    // Relative (the base path is the secret) and never served from cache.
    expect(fetchSpy).toHaveBeenCalledWith(INSTRUCTIONS_PAGE_PATH, { cache: 'no-cache' });
  });

  it('keeps the no-JS link when instructions.html is missing', async () => {
    const box = mountAndRunLoader((async () => new Response('not found', { status: 404 })) as unknown as typeof fetch);
    await new Promise((r) => setTimeout(r, 20));
    expect(box.innerHTML).toContain(noJsLink);
  });

  it('keeps the no-JS link when the request fails', async () => {
    const box = mountAndRunLoader((async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch);
    await new Promise((r) => setTimeout(r, 20));
    expect(box.innerHTML).toContain(noJsLink);
  });

  it('keeps the no-JS link when the served page has no instructions body', async () => {
    const box = mountAndRunLoader((async () => new Response('<html><body><p>something else</p></body></html>', { status: 200 })) as unknown as typeof fetch);
    await new Promise((r) => setTimeout(r, 20));
    expect(box.innerHTML).toContain(noJsLink);
  });
});
