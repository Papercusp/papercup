/**
 * @vitest-environment jsdom
 *
 * HowSharingWorks — the comb-hive-native-sharing P-012 in-UI explainer:
 * a trigger link + progressive-disclosure modal, open-state on the `?explain`
 * nuqs param, claimed/unclaimed copy reused from CLAIM_STATUS_COPY (the single
 * source it shares with the claim-badge tooltips, P-003). @testing-library/react
 * + vitest only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import { HowSharingWorks } from '../HowSharingWorks';
import { CLAIM_STATUS_COPY } from '../ClaimStatusBadge';

// useLexicon reads THE_HIVE via useFlag — default-on → the-hive pack (Hive/Comb).
const flagValues = vi.hoisted(() => ({}) as Record<string, boolean>);
vi.mock('@/lib/flag-hooks', () => ({ useFlag: (k: string) => flagValues[k] ?? true }));

beforeEach(() => {
  for (const k of Object.keys(flagValues)) delete flagValues[k];
});
afterEach(() => cleanup());

function renderLink(search = '') {
  return render(<HowSharingWorks />, { wrapper: withNuqsTestingAdapter({ searchParams: search }) });
}

describe('HowSharingWorks — P-012 explainer', () => {
  it('closed by default; clicking the link opens the modal', async () => {
    const user = userEvent.setup();
    renderLink();
    expect(screen.queryByRole('heading', { name: 'How sharing works' })).toBeNull();
    await user.click(screen.getByTestId('how-sharing-works-link'));
    screen.getByRole('heading', { name: 'How sharing works' });
  });

  it('opens directly when ?explain=sharing (agent-drivable via the URL)', () => {
    renderLink('?explain=sharing');
    screen.getByRole('heading', { name: 'How sharing works' });
  });

  it('reuses CLAIM_STATUS_COPY for the claimed/unclaimed section (single copy source)', () => {
    renderLink('?explain=sharing');
    screen.getByText(CLAIM_STATUS_COPY.claimed);
    screen.getByText(CLAIM_STATUS_COPY.unclaimed);
  });

  it('covers the six sections + the learn-more deep link (D-004 tail)', () => {
    renderLink('?explain=sharing');
    screen.getByText(/What's a hive\?/);
    screen.getByText(/Publishing — listing/);
    screen.getByText(/Joining — what you get/);
    screen.getByText(/Claimed vs unclaimed/);
    screen.getByText(/Invite links/);
    screen.getByText(/vs blueprints vs plugins/);
    const learn = screen.getByText(/How federation works/).closest('a');
    expect(learn?.getAttribute('href')).toBe('/internal/docs/agent-insights/hive-scoped-federation');
  });

  it('lexicon-bound: Comb/Hive vocabulary in the the-hive pack', () => {
    renderLink('?explain=sharing');
    // the-hive pack: cupboard → "Comb"; the publishing section names it.
    expect(screen.getByText(/indexes its member repos in the/).textContent).toContain('Comb');
  });
});
