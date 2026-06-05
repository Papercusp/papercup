/**
 * @vitest-environment jsdom
 *
 * Cupboard ListingCard — claim-status badge, publisher signal, and per-kind
 * action wiring.
 *
 * Regression guard for the Cupboard browse "provisional tag" gap: an
 * `unclaimed` (provisional) listing must surface the canonical
 * ClaimStatusBadge in its `unclaimed` state rather than render unlabeled.
 * Plus the three-listing-kind action contract (D-005): the card's primary
 * action button is Join (harness) / Fork (blueprint, snapshot) / Install
 * (plugin), driven by `listingAction()`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ListingCard } from '../CupboardClient';
import type { HarnessListing, ListingKind } from '@papercusp/operator-core/lib/cupboard/types';

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

describe('Cupboard ListingCard — claim-status badge', () => {
  it('surfaces the provisional (unclaimed) badge for an unclaimed listing', () => {
    render(
      <ListingCard
        listing={listing({ claim_status: 'unclaimed' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('claim-status-badge-unclaimed')).toBeTruthy();
    expect(screen.queryByTestId('claim-status-badge-claimed')).toBeNull();
  });

  it('shows the claimed badge for a claimed listing', () => {
    render(
      <ListingCard
        listing={listing({ claim_status: 'claimed' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('claim-status-badge-claimed')).toBeTruthy();
    expect(screen.queryByTestId('claim-status-badge-unclaimed')).toBeNull();
  });
});

describe('Cupboard ListingCard — publisher signal', () => {
  it('flags a non-collaborator publisher (read-only perm)', () => {
    render(
      <ListingCard
        listing={listing({ publisher_permission: 'read' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    const sig = screen.getByTestId('cupboard-publisher-signal');
    expect(sig.getAttribute('data-collaborator')).toBe('false');
  });

  it('marks a collaborator publisher (write perm)', () => {
    render(
      <ListingCard
        listing={listing({ publisher_permission: 'write' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('cupboard-publisher-signal').getAttribute('data-collaborator')).toBe('true');
  });

  it('shows no signal when permission is unknown (legacy row)', () => {
    render(
      <ListingCard
        listing={listing({ publisher_permission: null })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-publisher-signal')).toBeNull();
  });
});

describe('Cupboard ListingCard — per-kind action (D-005)', () => {
  const cases: Array<{ kind: ListingKind | undefined; action: string; label: string }> = [
    { kind: 'harness', action: 'join', label: 'Join' },
    { kind: 'blueprint', action: 'fork', label: 'Fork' },
    { kind: 'snapshot', action: 'fork', label: 'Fork' },
    { kind: 'plugin', action: 'install', label: 'Install' },
    { kind: 'pack', action: 'install', label: 'Install' }, // runtime-less code-tool pack (migration 006)
    { kind: undefined, action: 'join', label: 'Join' }, // absent kind ⇒ harness
  ];
  for (const c of cases) {
    it(`${c.kind ?? '(absent)'} → ${c.action} action`, () => {
      render(
        <ListingCard
          listing={listing({ listing_kind: c.kind })}
          onAction={() => {}}
          onDetail={() => {}}
        />,
      );
      const btn = screen.getByTestId('cupboard-action');
      expect(btn.getAttribute('data-action')).toBe(c.action);
      expect(btn.textContent).toContain(c.label);
    });
  }

  it('renders a kind badge reflecting the listing kind', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'plugin' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('cupboard-kind-badge').getAttribute('data-kind')).toBe('plugin');
  });

  it('renders a repo slug derived from worker fields when github_repo is absent', () => {
    render(
      <ListingCard
        listing={listing({ github_repo: undefined, github_owner: 'acme', github_name: 'widget' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    // The external-repo link title carries the derived slug.
    expect(screen.getByTitle('github.com/acme/widget')).toBeTruthy();
  });
});

describe('Cupboard ListingCard — Pot chip (per-Pot rollup, D-005)', () => {
  it('renders a clickable Pot chip when potRef + onPot are provided', () => {
    const onPot = vi.fn();
    render(
      <ListingCard
        listing={listing({ project_ref: 'papercupai/demo' })}
        onAction={() => {}}
        onDetail={() => {}}
        potRef="papercupai/demo"
        onPot={onPot}
      />,
    );
    const chip = screen.getByTestId('cupboard-pot-chip');
    expect(chip.getAttribute('data-pot')).toBe('papercupai/demo');
    chip.click();
    expect(onPot).toHaveBeenCalledTimes(1);
  });

  it('omits the Pot chip when onPot is not provided (rollup mode)', () => {
    render(
      <ListingCard
        listing={listing({ project_ref: 'papercupai/demo' })}
        onAction={() => {}}
        onDetail={() => {}}
        potRef="papercupai/demo"
      />,
    );
    expect(screen.queryByTestId('cupboard-pot-chip')).toBeNull();
  });

  it('omits the Pot chip when potRef is empty (ungroupable listing)', () => {
    render(
      <ListingCard
        listing={listing()}
        onAction={() => {}}
        onDetail={() => {}}
        potRef=""
        onPot={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-pot-chip')).toBeNull();
  });
});
