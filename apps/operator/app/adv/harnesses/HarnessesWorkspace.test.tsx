// @vitest-environment jsdom
//
// HarnessesWorkspace — the hive-aware /adv/harnesses shell. Real logic: the
// two URL axes (?slug hive / ?harness member) resolved through the pure
// harness-axis helpers, all-mode (?scope=all → workspace cards), the
// dock-vs-empty branch (focused member → dock; none → create CTA / error /
// no-hives empty states), the hive header gate, and the create-picker open. The
// registry rides useSyncQuery (mocked to a settable result); every heavy child
// is stubbed to a marker so we assert THIS component's branching.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement, ReactNode } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[]; error: Error | null };
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ ...syncResult, loading: false, fetching: false, invalidate: vi.fn() }),
}));
// Passthrough lexicon that honours the plural option so the empty-state copy
// ("No pots yet", "Failed to load pots") reads naturally against assertions.
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string, opts?: { plural?: boolean }) => (opts?.plural ? `${key}s` : key),
  HarnessLexiconProvider: ({ harnessSlug, children }: { harnessSlug: string; children: ReactNode }) => (
    <div data-testid="harness-lexicon" data-harness-slug={harnessSlug}>{children}</div>
  ),
}));
vi.mock('@/lib/useWorkspaceLabel', () => ({ useWorkspaceLabel: () => 'My Workspace' }));

vi.mock('./HarnessTopBar', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="topbar">{slug}</div> }));
vi.mock('./HarnessesDock', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="dock">{slug}</div> }));
vi.mock('./HarnessWelcome', () => ({ default: () => <div data-testid="welcome" /> }));
vi.mock('./PotMemberRail', () => ({
  default: ({ members, activeSlug }: { members: Array<{ slug: string }>; activeSlug: string | null }) => (
    <div data-testid="member-rail">
      {members.map((m) => m.slug).join(',')}|active:{activeSlug ?? ''}
    </div>
  ),
}));
// NO HiveHeaderStrip mock: this workspace stopped rendering it on 2026-07-27 —
// the hive identity/Share cluster moved to the pot bar (AdvPotBar) with the other
// pot-level chrome. Mocking a component the subject no longer mounts is what made
// the assertion below pass vacuously in one direction and fail in the other
// (EI-18814950644299297).
vi.mock('./PotWorkspaceCards', () => ({
  default: ({ onCreate }: { onCreate: () => void }) => (
    <div data-testid="workspace-cards">
      <button data-testid="cards-create" onClick={onCreate}>create</button>
    </div>
  ),
}));
vi.mock('../../harness/CreateHarnessPicker', () => ({
  CreateHarnessPicker: ({ open }: { open: boolean }) => (open ? <div data-testid="create-picker" /> : null),
}));

import HarnessesWorkspace from './HarnessesWorkspace';

function project(over: Record<string, unknown> = {}) {
  return { slug: 's', path: '/p', hasState: true, hasSpec: false, parent_slug: null, harness_kind: null, is_shared: false, ...over };
}

function renderWs(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

beforeEach(() => {
  syncResult = { data: [], error: null };
});
afterEach(cleanup);

describe('HarnessesWorkspace — empty / error states', () => {
  it('shows the no-hives empty state with a create CTA when the registry is empty and no slug', () => {
    syncResult = { data: [], error: null };
    renderWs(<HarnessesWorkspace />);
    expect(screen.getByText(/No pots yet/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create a pot/i })).toBeTruthy();
    expect(screen.queryByTestId('dock')).toBeNull();
  });

  it('shows the load-failure empty state when the registry query errors and no slug resolves', () => {
    syncResult = { data: [], error: new Error('registry down') };
    renderWs(<HarnessesWorkspace />);
    expect(screen.getByText(/Failed to load pots/i)).toBeTruthy();
    expect(screen.getByText(/registry down/i)).toBeTruthy();
  });

  it('with projects but no ?slug, shows the "select a pot" empty state + create CTA', () => {
    syncResult = { data: [project({ slug: 'alpha' })], error: null };
    renderWs(<HarnessesWorkspace />);
    expect(screen.getByText(/Select a pot from the selector/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create a pot/i })).toBeTruthy();
  });
});

describe('HarnessesWorkspace — dock branch', () => {
  it('mounts the dock + welcome for the focused solo harness when ?slug names a project', () => {
    syncResult = { data: [project({ slug: 'alpha' })], error: null };
    renderWs(<HarnessesWorkspace />, '?slug=alpha');
    expect(screen.getByTestId('dock').textContent).toBe('alpha');
    expect(screen.getByTestId('welcome')).toBeTruthy();
    expect(screen.getByTestId('topbar').textContent).toBe('alpha');
    expect(screen.getByTestId('harness-lexicon').getAttribute('data-harness-slug')).toBe('alpha');
  });

  it('focuses the ?harness member within the hive over the hive root', () => {
    syncResult = {
      data: [
        project({ slug: 'home', harness_kind: 'hive' }),
        project({ slug: 'web', parent_slug: 'home' }),
        project({ slug: 'api', parent_slug: 'home' }),
      ],
      error: null,
    };
    renderWs(<HarnessesWorkspace />, '?slug=home&harness=api');
    expect(screen.getByTestId('dock').textContent).toBe('api');
    expect(screen.getByTestId('harness-lexicon').getAttribute('data-harness-slug')).toBe('api');
  });

  it('renders the member rail for a multi-member hive', () => {
    syncResult = {
      data: [
        project({ slug: 'home', harness_kind: 'hive' }),
        project({ slug: 'web', parent_slug: 'home' }),
      ],
      error: null,
    };
    renderWs(<HarnessesWorkspace />, '?slug=home');
    expect(screen.getByTestId('member-rail')).toBeTruthy();
  });

  it('mounts the dock for a solo non-hive harness', () => {
    // The member rail is mounted unconditionally and decides its own visibility
    // from the member set — that logic belongs to (and is pinned by)
    // PotMemberRail.test.tsx, so this suite asserts only the branch it owns:
    // a solo slug lands on the dock, not the all-mode cards.
    syncResult = { data: [project({ slug: 'solo' })], error: null };
    renderWs(<HarnessesWorkspace />, '?slug=solo');
    expect(screen.getByTestId('dock').textContent).toBe('solo');
    expect(screen.queryByTestId('workspace-cards')).toBeNull();
  });
});

describe('HarnessesWorkspace — all-mode + create picker', () => {
  it('renders the workspace cards (not the dock) when ?scope=all', () => {
    syncResult = { data: [project({ slug: 'alpha' })], error: null };
    renderWs(<HarnessesWorkspace />, '?scope=all');
    expect(screen.getByTestId('workspace-cards')).toBeTruthy();
    expect(screen.queryByTestId('dock')).toBeNull();
  });

  it('the create CTA opens the CreateHarnessPicker', () => {
    syncResult = { data: [], error: null };
    renderWs(<HarnessesWorkspace />);
    expect(screen.queryByTestId('create-picker')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Create a pot/i }));
    expect(screen.getByTestId('create-picker')).toBeTruthy();
  });

  it('all-mode cards onCreate opens the CreateHarnessPicker', () => {
    syncResult = { data: [project({ slug: 'alpha' })], error: null };
    renderWs(<HarnessesWorkspace />, '?scope=all');
    fireEvent.click(screen.getByTestId('cards-create'));
    expect(screen.getByTestId('create-picker')).toBeTruthy();
  });
});
