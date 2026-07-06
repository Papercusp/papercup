/**
 * @vitest-environment jsdom
 *
 * Cupboard ListingCard — claim-status badge, publisher signal, and per-kind
 * action wiring.
 *
 * Regression guard for the Cupboard browse "provisional tag" gap: an
 * `unclaimed` (provisional) listing must surface the canonical
 * ClaimStatusBadge in its `unclaimed` state rather than render unlabeled.
 * Plus the per-listing action contract (D-005, reframed by
 * comb-retire-per-harness-sharing-2026-06-11): View Hive (hive-bound harness
 * row) / none (legacy harness row — per-harness join retired) / Fork
 * (blueprint) / Install (plugin, pack), driven by `listingActionFor()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement } from 'react';

// Lexicon resolver echoes its key (t('pot') → 'pot') — isolates the hive→pot
// routed copy from the THE_HIVE flag hook (restore-pot-lexicon-public-release P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@/lib/router-compat/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('nuqs', async () => {
  const React = await import('react');
  const withDefault = (defaultValue: unknown) => ({ defaultValue });
  return {
    parseAsString: { withDefault },
    parseAsStringEnum: () => ({ withDefault }),
    useQueryState: (_key: string, parser?: { defaultValue?: unknown }) =>
      React.useState(parser && 'defaultValue' in parser ? parser.defaultValue : null),
  };
});

import CupboardClient, { ListingCard, HiveBrowseCard, HiveRollupHeaderCard } from '../CupboardClient';
import { groupHarnessRowsByHive } from '@papercusp/operator-core/lib/cupboard/types';
import type { HarnessListing, ListingKind } from '@papercusp/operator-core/lib/cupboard/types';

afterEach(() => cleanup());

/** Radix Tooltip needs its provider (the SPA root mounts one globally). */
function withTooltips(ui: ReactElement) {
  return render(<RadixTooltip.Provider delayDuration={0}>{ui}</RadixTooltip.Provider>);
}

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

const HIVE_PK = 'A'.repeat(43) + '=';

describe('CupboardClient — WI-3259 tab switching and loading state', () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({
        listings: [
          listing({ id: 1, title: 'Harness listing', listing_kind: 'harness', hive_pubkey: HIVE_PK }),
          listing({ id: 2, title: 'Plugin listing', listing_kind: 'plugin' }),
        ],
      }),
      { status: 200 },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not refetch listings when switching kind tabs', async () => {
    withTooltips(<CupboardClient />);

    await waitFor(() => expect(screen.getByText('Plugin listing')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/cupboard/listings?');

    fireEvent.click(screen.getByTestId('cupboard-kind-tab-plugin'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Plugin listing')).toBeTruthy();
    expect(screen.queryByText('Harness listing')).toBeNull();
  });

  it('shows an explicit listings loading indicator while the fetch is in flight', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    withTooltips(<CupboardClient />);

    expect(screen.getByTestId('cupboard-loading-indicator').textContent).toContain('Loading');
    expect(screen.getByTestId('cupboard-results').getAttribute('aria-busy')).toBe('true');
  });
});

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

describe('Cupboard ListingCard — per-listing action (D-005 / comb-retire)', () => {
  const cases: Array<{ kind: ListingKind; action: string; label: string }> = [
    { kind: 'blueprint', action: 'install', label: 'Install' },
    // ('snapshot → fork' removed — snapshot kind retired by retire-snapshots-instance-spec-2026-06-09 D-005.)
    { kind: 'plugin', action: 'install', label: 'Install' },
    { kind: 'tool-pack', action: 'install', label: 'Install' }, // runtime-less code-tool pack (mig 006, renamed mig 008)
    { kind: 'learning-pack', action: 'install', label: 'Install' }, // curated hive learnings (learning-packs mig 008)
  ];
  for (const c of cases) {
    it(`${c.kind} → ${c.action} action`, () => {
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

  it('hive-bound harness row → View Hive action (the repo→Hive lookup index)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'harness', hive_pubkey: 'k'.repeat(44), hive_title: 'Demo Hive' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    const btn = screen.getByTestId('cupboard-action');
    expect(btn.getAttribute('data-action')).toBe('view-hive');
    // Label routed through the lexicon (echoed key 'pot'), not the hardcoded "Hive".
    expect(btn.textContent).toContain('View pot');
  });

  it('legacy harness row (no hive) → NO primary action (per-harness join retired)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'harness' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-action')).toBeNull();
  });

  it('absent kind ⇒ harness semantics (legacy row, no primary action)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: undefined })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-action')).toBeNull();
  });

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
    // The external-repo link accessible name carries the derived slug.
    expect(screen.getByRole('link', { name: 'Open github.com/acme/widget' })).toBeTruthy();
  });
});

describe('Cupboard ListingCard — Hive chip (per-Hive rollup, D-005)', () => {
  it('renders a clickable Hive chip when hiveRef + onHive are provided', () => {
    const onHive = vi.fn();
    render(
      <ListingCard
        listing={listing({ project_ref: 'papercupai/demo' })}
        onAction={() => {}}
        onDetail={() => {}}
        hiveRef="papercupai/demo"
        onHive={onHive}
      />,
    );
    const chip = screen.getByTestId('cupboard-hive-chip');
    expect(chip.getAttribute('data-hive')).toBe('papercupai/demo');
    chip.click();
    expect(onHive).toHaveBeenCalledTimes(1);
  });

  it('omits the Hive chip when onHive is not provided (rollup mode)', () => {
    render(
      <ListingCard
        listing={listing({ project_ref: 'papercupai/demo' })}
        onAction={() => {}}
        onDetail={() => {}}
        hiveRef="papercupai/demo"
      />,
    );
    expect(screen.queryByTestId('cupboard-hive-chip')).toBeNull();
  });

  it('omits the Hive chip when hiveRef is empty (ungroupable listing)', () => {
    render(
      <ListingCard
        listing={listing()}
        onAction={() => {}}
        onDetail={() => {}}
        hiveRef=""
        onHive={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-hive-chip')).toBeNull();
  });
});

// ─── comb-hive-native-sharing-2026-06-11 Phase 1 ────────────────────────────

describe('ListingCard — suppressViewHive (rollup mode, P-001)', () => {
  it('hides the redundant View Hive button inside the rollup', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'harness', hive_pubkey: HIVE_PK })}
        onAction={() => {}}
        onDetail={() => {}}
        suppressViewHive
      />,
    );
    expect(screen.queryByTestId('cupboard-action')).toBeNull();
  });

  it('keeps Fork/Install actions in rollup mode (only view-hive is redundant)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'blueprint' })}
        onAction={() => {}}
        onDetail={() => {}}
        suppressViewHive
      />,
    );
    expect(screen.getByTestId('cupboard-action').getAttribute('data-action')).toBe('install');
  });
});

describe('HiveBrowseCard — hive-first flat browse (P-002)', () => {
  function group() {
    const rows = [
      listing({ id: 1, hive_pubkey: HIVE_PK, hive_title: 'Demo Hive', github_repo: 'o/r1', claim_status: 'claimed' }),
      listing({ id: 2, hive_pubkey: HIVE_PK, github_repo: 'o/r2' }),
    ];
    return groupHarnessRowsByHive(rows).hives[0];
  }

  it('renders ONE card per hive: title, member repos, claim rollup, View Hive CTA', () => {
    const onOpen = vi.fn();
    withTooltips(<HiveBrowseCard group={group()} onOpen={onOpen} />);
    const card = screen.getByTestId('cupboard-hive-card');
    expect(card.getAttribute('data-hive-pubkey')).toBe(HIVE_PK);
    expect(card.textContent).toContain('Demo Hive');
    expect(card.textContent).toContain('o/r1');
    expect(card.textContent).toContain('o/r2');
    expect(screen.getByTestId('cupboard-claim-rollup').textContent).toContain('1/2 claimed');
    fireEvent.click(screen.getByTestId('cupboard-hive-card-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('HiveRollupHeaderCard — the hive as the joinable unit (P-001/P-003)', () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const members = [
    listing({ id: 1, hive_pubkey: HIVE_PK, hive_title: 'Demo Hive', github_repo: 'o/r1' }),
    listing({ id: 2, hive_pubkey: HIVE_PK, github_repo: 'o/r2', claim_status: 'claimed' }),
  ];

  function directoryResponds(rows: unknown[]) {
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/discovery/pots')) {
        return new Response(JSON.stringify({ count: rows.length, rows }), { status: 200 });
      }
      if (u.includes('/api/discovery/join-pot')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { memberLinks?: string[] };
        return new Response(
          JSON.stringify({ ok: true, hiveSlug: 'demo-hive', members: (body.memberLinks ?? []).map(() => ({ ok: true })) }),
          { status: 200 },
        );
      }
      if (u.includes('/claim')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
  }

  it('resolves the announce by hive_pubkey: title, visibility, Join CTA → join-pot', async () => {
    directoryResponds([
      {
        hiveId: 'demo', title: 'Demo Hive', description: '', owner: 'alice',
        visibility: 'public', memberLinks: ['papercusp://harness?topic=a', 'papercusp://harness?topic=b'],
        memberCount: 2, hivePubkey: HIVE_PK,
      },
    ]);
    withTooltips(<HiveRollupHeaderCard hiveRef={HIVE_PK} members={members} onClaimed={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('cupboard-hive-join')).toBeTruthy());
    expect(screen.getByTestId('cupboard-hive-rollup-title').textContent).toBe('Demo Hive');
    expect(screen.getByTestId('cupboard-hive-visibility').getAttribute('data-visibility')).toBe('public');
    fireEvent.click(screen.getByTestId('cupboard-hive-join'));
    await waitFor(() =>
      expect(screen.getByTestId('cupboard-hive-join-msg').textContent).toContain("Joined pot 'demo-hive' — 2/2"),
    );
    const joinCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('join-pot'))!;
    expect(JSON.parse(String((joinCall[1] as RequestInit).body))).toMatchObject({ hiveId: 'demo' });
  });

  it('honest empty-state + invite-link affordance when no announce resolves', async () => {
    directoryResponds([]);
    withTooltips(<HiveRollupHeaderCard hiveRef={HIVE_PK} members={members} onClaimed={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('cupboard-hive-join-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('cupboard-hive-join')).toBeNull();
    expect(screen.getByTestId('cupboard-hive-invite-input')).toBeTruthy();
    expect(screen.getByTestId('cupboard-hive-join-unavailable').textContent).toContain("isn't announcing");
  });

  it('claim rollup + Claim CTA drive the loopback claim proxy for unclaimed members (P-003)', async () => {
    directoryResponds([]);
    const onClaimed = vi.fn();
    withTooltips(<HiveRollupHeaderCard hiveRef={HIVE_PK} members={members} onClaimed={onClaimed} />);
    await waitFor(() => expect(screen.getByTestId('cupboard-hive-claim')).toBeTruthy());
    expect(screen.getByTestId('cupboard-claim-rollup').textContent).toContain('1/2 claimed');
    fireEvent.click(screen.getByTestId('cupboard-hive-claim'));
    await waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(1));
    const claimCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/claim'));
    // Only the UNCLAIMED member (id 1) is claimed — id 2 already is.
    expect(claimCalls.map((c) => String(c[0]))).toEqual(['/api/cupboard/listings/1/claim']);
  });
});
