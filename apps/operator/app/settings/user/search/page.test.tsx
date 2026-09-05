// @vitest-environment jsdom
/**
 * Workspace search page — malicious-markup regression
 * (security-boundary-remediation-and-usability-2026-09-04 P-003, under D-001).
 *
 * The prose column renders through `dangerouslySetInnerHTML`, and its corpus is
 * escalations / brainstorm notes / operator turns — text that quotes markup as a
 * matter of course. So the escaping is the only thing standing between an
 * ordinary note and script execution, and D-001 requires proving BOTH halves:
 * the hostile path is inert, and highlighting still works.
 *
 * Only the page's own presentational deps are mocked (nuqs, Select, Tooltip)
 * plus `fetch`; the render path under test — hit → `hitDisplayHtml` → innerHTML
 * — is the real one, which is the point of a component-level test rather than
 * another unit test of the escaper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createNuqsMock } from '@papercusp/test-config/nuqs-mock';

vi.mock('nuqs', () => createNuqsMock({ initial: { q: 'deploy', mode: 'hybrid' } }));
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value }: { value: string }) => <span data-testid="mode">{value}</span>,
}));

import SearchPage from './page';

function proseHit(over: Record<string, unknown>) {
  return {
    source: 'turns', source_id: 't1', harness_slug: 'papercusp',
    excerpt: 'plain excerpt', highlight: 'plain highlight', rank: 1,
    ...over,
  };
}

/** Render, run the search, and hand back the prose result bodies. */
async function search(prose: unknown[]): Promise<HTMLElement[]> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ q: 'deploy', memories: [], prose }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  );
  render(<SearchPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => expect(screen.getAllByTestId('prose-hit-body').length).toBe(prose.length));
  return screen.getAllByTestId('prose-hit-body');
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('workspace search — prose hit rendering', () => {
  it('renders corpus markup inert while keeping <mark> highlighting', async () => {
    const [body] = await search([
      proseHit({ highlight: 'the <mark>deploy</mark> ran <img src=x onerror="alert(1)">' }),
    ]);

    // HOSTILE PATH FAILS. `<img onerror>` is the vector that actually matters:
    // it needs no <script> tag, so it survives any filter that only strips one.
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('script')).toBeNull();
    // …and it is still SHOWN as text — escaping must not silently eat content,
    // or a search that finds markup becomes unable to display it.
    expect(body.textContent).toContain('<img src=x onerror="alert(1)">');

    // LEGITIMATE PATH SUCCEEDS: the engine's own <mark> is a real element.
    const marks = body.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('deploy');
  });

  it('falls back to the excerpt for a hit with no highlight, and escapes that too', async () => {
    // In `hybrid` mode a purely SEMANTIC hit has no matched term to mark, and a
    // hit whose source deferred highlight hydration (WI-4734) can arrive with
    // `highlight: ''`. Before P-003 this column read `h.highlight` alone, so
    // those rows rendered as blank cards.
    const [body] = await search([
      proseHit({ highlight: '', excerpt: 'semantic <b>match</b> <script>alert(2)</script>' }),
    ]);

    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelector('b')).toBeNull();
    expect(body.textContent).toContain('semantic <b>match</b> <script>alert(2)</script>');
  });

  it('escapes every hit in a mixed result set, not just the first', async () => {
    const bodies = await search([
      proseHit({ source_id: 't1', highlight: '<mark>ok</mark>' }),
      proseHit({ source_id: 't2', source: 'escalations', highlight: '<svg/onload=alert(1)>' }),
      proseHit({ source_id: 't3', source: 'brainstorm', highlight: '', excerpt: '<iframe src="javascript:alert(1)">' }),
    ]);

    expect(bodies).toHaveLength(3);
    expect(bodies[0].querySelectorAll('mark')).toHaveLength(1);
    for (const body of bodies) {
      expect(body.querySelector('svg')).toBeNull();
      expect(body.querySelector('iframe')).toBeNull();
      expect(body.querySelector('script')).toBeNull();
    }
  });
});
