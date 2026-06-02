/**
 * @vitest-environment jsdom
 *
 * Cupboard HarnessCard — claim-status badge wiring.
 *
 * Regression guard for the Cupboard browse "provisional tag" gap: an
 * `unclaimed` (provisional) listing must surface the canonical
 * ClaimStatusBadge in its `unclaimed` state rather than render
 * unlabeled. The card previously hand-rolled a `claimed`-only badge, so
 * provisional listings — the ones a viewer most needs flagged before
 * installing — showed nothing, indistinguishable from a verified-owned
 * one. See the design memo
 * `cupboard-provisional-listing-trust-2026-06-02`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HarnessCard } from '../CupboardClient';
import type { HarnessListing } from '@/lib/cupboard/types';

afterEach(() => cleanup());

function listing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return {
    id: 1,
    slug: 'demo',
    title: 'Demo harness',
    description: '',
    harness_link: 'papercusp://harness?topic=abc&github=o/r&repo_id=1',
    github_repository_id: 1,
    github_repo: 'o/r',
    github_repo_must_be_public: true,
    published_by_github_user_id: 10,
    provisional_owner_github_user_id: 10,
    claim_status: 'unclaimed',
    claimed_at: null,
    last_permission_verified_at: null,
    superseded_by_harness_id: null,
    contributor_count_estimate: 0,
    last_activity_at: null,
    language: null,
    tags: [],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe('Cupboard HarnessCard — claim-status badge', () => {
  it('surfaces the provisional (unclaimed) badge for an unclaimed listing', () => {
    render(
      <HarnessCard
        listing={listing({ claim_status: 'unclaimed' })}
        onInstall={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('claim-status-badge-unclaimed')).toBeTruthy();
    expect(screen.queryByTestId('claim-status-badge-claimed')).toBeNull();
  });

  it('shows the claimed badge for a claimed listing', () => {
    render(
      <HarnessCard
        listing={listing({ claim_status: 'claimed' })}
        onInstall={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('claim-status-badge-claimed')).toBeTruthy();
    expect(screen.queryByTestId('claim-status-badge-unclaimed')).toBeNull();
  });
});

describe('Cupboard HarnessCard — publisher signal', () => {
  it('flags a non-collaborator publisher (read-only perm)', () => {
    render(
      <HarnessCard
        listing={listing({ publisher_permission: 'read' })}
        onInstall={() => {}}
        onDetail={() => {}}
      />,
    );
    const sig = screen.getByTestId('cupboard-publisher-signal');
    expect(sig.getAttribute('data-collaborator')).toBe('false');
  });

  it('marks a collaborator publisher (write perm)', () => {
    render(
      <HarnessCard
        listing={listing({ publisher_permission: 'write' })}
        onInstall={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('cupboard-publisher-signal').getAttribute('data-collaborator')).toBe('true');
  });

  it('shows no signal when permission is unknown (legacy row)', () => {
    render(
      <HarnessCard
        listing={listing({ publisher_permission: null })}
        onInstall={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-publisher-signal')).toBeNull();
  });
});
