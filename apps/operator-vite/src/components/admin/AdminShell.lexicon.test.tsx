// @vitest-environment jsdom
//
// P-006 — a real nav surface renders correctly under BOTH brand packs.
// AdminShell's Cupboard tab must read "Cupboard" with the-hive off and "Comb"
// with it on, and flip live. The other (non-lexicon) tabs are unchanged.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { FLAGS, type FlagPayload, resolveWithDefaults } from '@papercusp/flags';
import { setFlagPayload } from '@papercusp/flags/client';

// Render the TSR primitives AdminShell needs without a real router.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: () => '/admin/run',
}));

import AdminShell from './AdminShell';

function setHive(on: boolean): void {
  const payload: FlagPayload = {
    flags: resolveWithDefaults({ [FLAGS.THE_HIVE]: on }),
    evaluatedAt: 1,
    source: 'override',
  };
  act(() => setFlagPayload(payload));
}

afterEach(() => {
  cleanup();
  setHive(false);
});

describe('AdminShell lexicon (P-006)', () => {
  it('classic: Cupboard tab reads "Cupboard"', () => {
    setHive(false);
    render(
      <AdminShell title="Admin">
        <div />
      </AdminShell>,
    );
    expect(screen.getByText('Cupboard')).toBeTruthy();
    expect(screen.queryByText('Comb')).toBeNull();
    // A non-lexicon tab is unaffected by the brand pack.
    expect(screen.getByText('DBOS')).toBeTruthy();
  });

  it('the-hive: Cupboard tab reads "Comb"', () => {
    setHive(true);
    render(
      <AdminShell title="Admin">
        <div />
      </AdminShell>,
    );
    expect(screen.getByText('Comb')).toBeTruthy();
    expect(screen.queryByText('Cupboard')).toBeNull();
    expect(screen.getByText('DBOS')).toBeTruthy();
  });

  it('flips live when the flag changes', () => {
    setHive(false);
    render(
      <AdminShell title="Admin">
        <div />
      </AdminShell>,
    );
    expect(screen.getByText('Cupboard')).toBeTruthy();
    setHive(true);
    expect(screen.getByText('Comb')).toBeTruthy();
    expect(screen.queryByText('Cupboard')).toBeNull();
  });
});
