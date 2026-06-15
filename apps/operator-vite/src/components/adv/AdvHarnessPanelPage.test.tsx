// @vitest-environment jsdom
/**
 * AdvHarnessPanelPage.test — the /adv per-pot harness panel router
 * (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09 P-008/P-009).
 *
 * This file is a thin ROUTER: scope=all → a per-pot empty hint; panel 'git' →
 * AdvGitWorkspace; the DIRECT registry panels (brainstorm/prs/insights/settings/
 * docs/testing) → their component, but only with a selected ?slug=. The heavy
 * child panels + the lexicon/flag hooks are stubbed so we can assert the routing
 * + the BLUEPRINT_AWARE_SETTINGS flag swap on Settings without their trees.
 *
 * nuqs is mocked with a controllable per-key store (the AdvShell.test pattern):
 * setters are no-op spies; tests seed slug/scope before each render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// ── nuqs: per-key store the tests seed; setters are inert spies. ──
const nuqsState: Record<string, unknown> = { slug: null, scope: 'expanded' };
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => [nuqsState[key], vi.fn(async () => {})],
  parseAsString: {},
  parseAsStringEnum: () => ({ withDefault: (d: unknown) => ({ __default: d }) }),
}));

// ── Lexicon: identity-ish resolver ('pot' → 'pot', 'Pot'). ──
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (term: string, opts?: { lower?: boolean }) => (opts?.lower ? term : term[0].toUpperCase() + term.slice(1)),
}));

// ── Flag: BLUEPRINT_AWARE_SETTINGS — flipped per-test via the ref. ──
const flagRef = { blueprintAware: false };
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => flagRef.blueprintAware }));

// ── Heavy child panels: stub each to a marker element with its slug. ──
vi.mock('@/app/adv/harnesses/AdvGitWorkspace', () => ({ default: () => <div data-testid="git-workspace">git</div> }));
vi.mock('@/app/harness/brainstorm/BrainstormFull', () => ({ BrainstormFull: ({ slug }: { slug: string }) => <div data-testid="brainstorm">{slug}</div> }));
vi.mock('@/app/harness/PrsTab', () => ({ default: ({ harnessSlug }: { harnessSlug: string }) => <div data-testid="prs">{harnessSlug}</div> }));
vi.mock('@/app/harness/HarnessSettingsPanel', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="settings-legacy">{slug}</div> }));
vi.mock('@/app/harness/BlueprintSettingsPanel', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="settings-blueprint">{slug}</div> }));
vi.mock('@/app/harness/insights/InsightsTab', () => ({ InsightsTab: () => <div data-testid="insights" /> }));
vi.mock('@/app/adv/harnesses/AdvDocsTab', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="docs">{slug}</div> }));
vi.mock('@/app/adv/harnesses/HarnessTestsView', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="testing">{slug}</div> }));

import AdvHarnessPanelPage, { ADV_HARNESS_PANEL_LABELS } from './AdvHarnessPanelPage';

beforeEach(() => {
  nuqsState.slug = null;
  nuqsState.scope = 'expanded';
  flagRef.blueprintAware = false;
});
afterEach(() => cleanup());

describe('ADV_HARNESS_PANEL_LABELS', () => {
  it('labels every routable harness panel', () => {
    expect(ADV_HARNESS_PANEL_LABELS).toEqual({
      brainstorm: 'Brainstorm',
      prs: 'PRs',
      insights: 'Insights',
      settings: 'Settings',
      docs: 'Docs',
      git: 'Git',
      testing: 'Tests',
    });
  });
});

describe('<AdvHarnessPanelPage> routing', () => {
  it('scope=all → the per-pot empty hint, no child panel', () => {
    nuqsState.scope = 'all';
    nuqsState.slug = 'pot-a';
    render(<AdvHarnessPanelPage panel="brainstorm" />);
    expect(screen.getByText(/is a per-pot view — pick a single Pot above/)).toBeTruthy();
    expect(screen.queryByTestId('brainstorm')).toBeNull();
  });

  it('panel=git → AdvGitWorkspace (owns its own slug; renders even without ?slug=)', () => {
    render(<AdvHarnessPanelPage panel="git" />);
    expect(screen.getByTestId('git-workspace')).toBeTruthy();
  });

  it('a DIRECT panel with a selected slug renders that panel, threading the slug', () => {
    nuqsState.slug = 'pot-x';
    render(<AdvHarnessPanelPage panel="brainstorm" />);
    expect(screen.getByTestId('brainstorm').textContent).toBe('pot-x');
  });

  it('PrsTab receives the slug as harnessSlug', () => {
    nuqsState.slug = 'pot-prs';
    render(<AdvHarnessPanelPage panel="prs" />);
    expect(screen.getByTestId('prs').textContent).toBe('pot-prs');
  });

  it('a DIRECT panel with NO slug renders the "Select a Pot." prompt', () => {
    nuqsState.slug = null;
    render(<AdvHarnessPanelPage panel="docs" />);
    expect(screen.getByText('Select a Pot.')).toBeTruthy();
    expect(screen.queryByTestId('docs')).toBeNull();
  });

  it('Settings → legacy panel when the blueprint flag is OFF', () => {
    nuqsState.slug = 'pot-s';
    flagRef.blueprintAware = false;
    render(<AdvHarnessPanelPage panel="settings" />);
    expect(screen.getByTestId('settings-legacy')).toBeTruthy();
    expect(screen.queryByTestId('settings-blueprint')).toBeNull();
  });

  it('Settings → blueprint panel when the flag is ON', () => {
    nuqsState.slug = 'pot-s';
    flagRef.blueprintAware = true;
    render(<AdvHarnessPanelPage panel="settings" />);
    expect(screen.getByTestId('settings-blueprint')).toBeTruthy();
    expect(screen.queryByTestId('settings-legacy')).toBeNull();
  });

  it('testing panel routes to HarnessTestsView with the slug', () => {
    nuqsState.slug = 'pot-t';
    render(<AdvHarnessPanelPage panel="testing" />);
    expect(screen.getByTestId('testing').textContent).toBe('pot-t');
  });
});
