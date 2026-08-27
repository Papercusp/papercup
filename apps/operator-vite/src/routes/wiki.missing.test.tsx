// @vitest-environment jsdom
/**
 * /wiki/missing route coverage — unresolved wiki links must land on an
 * intentional page rather than the root route's generic 404 component.
 */
import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let searchVal: { target?: string; harness?: string };
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useSearch: () => searchVal }),
}));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (term: string, options?: { lower?: boolean }) => (options?.lower ? term.toLowerCase() : term),
}));

import { Route } from './wiki.missing';

const validateSearch = (Route as unknown as {
  validateSearch: (search: Record<string, unknown>) => { target?: string; harness?: string };
}).validateSearch;
const Page = (Route as unknown as { component: () => JSX.Element }).component;

afterEach(cleanup);

describe('/wiki/missing validateSearch', () => {
  it('keeps string target and harness values', () => {
    expect(validateSearch({ target: 'knowledge', harness: 'papercusp' })).toEqual({
      target: 'knowledge',
      harness: 'papercusp',
    });
  });

  it('drops non-string query values', () => {
    expect(validateSearch({ target: 42, harness: {} })).toEqual({ target: undefined, harness: undefined });
    expect(validateSearch({})).toEqual({ target: undefined, harness: undefined });
  });
});

describe('/wiki/missing page', () => {
  it('renders an intentional missing-link page with the target and dashboard link', () => {
    searchVal = { target: 'definitely-not-a-real-target', harness: 'papercusp' };
    render(<Page />);

    expect(screen.getByRole('heading', { name: 'Wiki link not found' })).toBeTruthy();
    expect(screen.getByText('[[definitely-not-a-real-target]]')).toBeTruthy();
    expect(screen.getByText(/No file matched/).textContent).toContain('in pot papercusp');
    expect(screen.getByRole('link', { name: /Back to pot dashboard/ }).getAttribute('href')).toBe('/adv?tab=harnesses');
  });
});
