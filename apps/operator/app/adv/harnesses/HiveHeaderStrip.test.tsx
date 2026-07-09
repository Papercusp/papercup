/**
 * @vitest-environment jsdom
 *
 * HiveHeaderStrip — the hive face strip (harnesses-tab-hive-model P-022).
 * Verifies the member-count + liveness derivation, the kind/shared/deploy
 * badges, the empty-slug guard, the P-005 directory-state chrome (registry
 * meta → Public/Invite/Private/Unpublished; legacy is_shared only on non-hive
 * pots), and the P-004 Share button → ShareHiveDialog wiring. Lexicon is
 * mocked to a passthrough so the test asserts structure, not flag-resolved
 * wording.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { HiveShareMeta } from '@/app/harness/ShareHiveDialog';
import HiveHeaderStrip from './HiveHeaderStrip';

vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string) => key, // passthrough: t('pot') → 'pot'
}));

// The kind:'hive' strip reads its beacon consent + share meta on mount via the
// default seams (GETs) — stub fetch so tests don't reach the network. Tests
// that care inject the seams directly and ignore this stub.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, consent: false }), { status: 200 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = { wrapper: withNuqsTestingAdapter() };

function shareMeta(over: Partial<HiveShareMeta> = {}): HiveShareMeta {
  return {
    potId: 'acme',
    found: true,
    visibility: 'public',
    title: 'acme',
    description: '',
    inviteSecret: null,
    hivePubkey: null,
    memberRepos: [],
    ...over,
  };
}

describe('HiveHeaderStrip', () => {
  it('renders the hive name + member count + set-up liveness', () => {
    render(
      <HiveHeaderStrip
        potSlug="acme"
        hiveKind="hive"
        members={[
          { slug: 'acme', hasState: true },
          { slug: 'acme-web', hasState: true },
          { slug: 'acme-api', hasState: false },
        ]}
      />,
      wrap,
    );
    screen.getByTestId('hive-header-strip');
    screen.getByText('acme');
    // 3 members, 2 set up.
    expect(screen.getByText(/3 harness/)).toBeTruthy();
    expect(screen.getByText('2/3 set up')).toBeTruthy();
  });

  it('shows the Hive-home crown badge for a kind:hive root', () => {
    render(
      <HiveHeaderStrip potSlug="acme" hiveKind="hive" members={[{ slug: 'acme', hasState: true }]} />,
      wrap,
    );
    expect(screen.getByText(/👑/).textContent).toContain('pot'); // hiveLabel passthrough
  });

  it('renders the deploy badge only when deployed', () => {
    const { rerender } = render(
      <HiveHeaderStrip potSlug="acme" members={[{ slug: 'acme' }]} />,
      wrap,
    );
    expect(screen.queryByText('deployed')).toBeNull();
    rerender(<HiveHeaderStrip potSlug="acme" members={[{ slug: 'acme' }]} deployed />);
    screen.getByText('deployed');
  });

  it('renders nothing for an empty slug', () => {
    const { container } = render(<HiveHeaderStrip potSlug="" members={[]} />, wrap);
    expect(container.querySelector('[data-testid="hive-header-strip"]')).toBeNull();
  });
});

describe('P-005 — the directory-state chrome (comb-hive-native-sharing-2026-06-11)', () => {
  it.each([
    ['public', 'Public'],
    ['invite', 'Invite'],
    ['private', 'Private'],
  ] as const)('a published %s hive shows the %s badge from registry meta', async (viz, label) => {
    render(
      <HiveHeaderStrip
        potSlug="acme"
        hiveKind="hive"
        members={[]}
        fetchShareMeta={async () => shareMeta({ visibility: viz })}
      />,
      wrap,
    );
    await waitFor(() =>
      expect(screen.getByTestId('hive-directory-state').textContent).toBe(label),
    );
  });

  it('a never-published hive shows Unpublished', async () => {
    render(
      <HiveHeaderStrip
        potSlug="acme"
        hiveKind="hive"
        members={[]}
        fetchShareMeta={async () => shareMeta({ found: false, visibility: null })}
      />,
      wrap,
    );
    await waitFor(() =>
      expect(screen.getByTestId('hive-directory-state').textContent).toBe('Unpublished'),
    );
  });

  it('the legacy is_shared badge renders ONLY on non-hive pots (O-2)', async () => {
    render(<HiveHeaderStrip potSlug="plain-root" isShared members={[]} />, wrap);
    expect(screen.getByLabelText('Shared')).toBeTruthy();
    expect(screen.queryByTestId('hive-directory-state')).toBeNull();
    cleanup();
    render(
      <HiveHeaderStrip
        potSlug="acme"
        hiveKind="hive"
        isShared
        members={[]}
        fetchShareMeta={async () => shareMeta()}
      />,
      wrap,
    );
    await waitFor(() => screen.getByTestId('hive-directory-state'));
    expect(screen.queryByLabelText('Shared')).toBeNull();
  });
});

describe('P-004 — the Share button → ShareHiveDialog (comb-hive-native-sharing-2026-06-11)', () => {
  it('renders the Share button only for a formal hive home', () => {
    render(<HiveHeaderStrip potSlug="plain-root" members={[]} />, wrap);
    expect(screen.queryByTestId('hive-share-button')).toBeNull();
    cleanup();
    render(<HiveHeaderStrip potSlug="acme" hiveKind="hive" members={[]} />, wrap);
    expect(screen.getByTestId('hive-share-button')).toBeTruthy();
  });

  it('clicking Share opens the dialog with the share form', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    render(
      <HiveHeaderStrip
        potSlug="acme"
        hiveKind="hive"
        members={[]}
        fetchShareMeta={async () => shareMeta({ found: false, visibility: null })}
      />,
      wrap,
    );
    expect(screen.queryByTestId('share-hive-form')).toBeNull();
    await user.click(screen.getByTestId('hive-share-button'));
    await screen.findByTestId('share-hive-form');
  });

  it('a dialog save updates the directory-state badge without a refetch', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    render(
      <HiveHeaderStrip
        potSlug="acme"
        hiveKind="hive"
        members={[]}
        fetchShareMeta={async () => shareMeta({ found: false, visibility: null })}
        setHiveListing={async () => ({ ok: true, announced: true })}
      />,
      wrap,
    );
    await waitFor(() =>
      expect(screen.getByTestId('hive-directory-state').textContent).toBe('Unpublished'),
    );
    await user.click(screen.getByTestId('hive-share-button'));
    await screen.findByTestId('share-hive-form');
    // Default selection for an unpublished hive is public — submit it.
    await user.click(screen.getByTestId('share-hive-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('hive-directory-state').textContent).toBe('Public'),
    );
  });
});

describe('B-07 / C-2 — the beacon-publish consent toggle (hive-network-surface-2026-06-11)', () => {
  const seams = (over?: {
    get?: (slug: string) => Promise<boolean>;
    set?: (slug: string, consent: boolean) => Promise<{ ok: boolean; consent?: boolean; error?: string }>;
  }) => ({
    getBeaconConsent: over?.get ?? (async () => false),
    setBeaconConsent: over?.set ?? (async (_s: string, consent: boolean) => ({ ok: true, consent })),
  });

  it('renders the consent control only for a formal hive home, carrying the ratified question', () => {
    render(<HiveHeaderStrip potSlug="plain-root" members={[]} {...seams()} />, wrap);
    expect(screen.queryByTestId('hive-beacon-consent')).toBeNull();
    cleanup();
    render(<HiveHeaderStrip potSlug="acme-hive" hiveKind="hive" members={[]} {...seams()} />, wrap);
    expect(screen.getByTestId('hive-beacon-consent')).toBeTruthy();
    // The publish-flow question rides the control (D-002: never ONLY a buried toggle).
    screen.getByText(/also publish a live status beacon\? \(recommended for/i);
  });

  it('reads the current consent on mount (absent = OFF; granted = on)', async () => {
    render(
      <HiveHeaderStrip potSlug="acme-hive" hiveKind="hive" members={[]} {...seams({ get: async () => true })} />,
      wrap,
    );
    await waitFor(() => expect(screen.getByTestId('hive-beacon-toggle').textContent).toBe('on'));
  });

  it('toggling drives the set seam and reflects the new state', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const calls: Array<[string, boolean]> = [];
    render(
      <HiveHeaderStrip
        potSlug="acme-hive"
        hiveKind="hive"
        members={[]}
        {...seams({
          get: async () => false,
          set: async (slug, consent) => {
            calls.push([slug, consent]);
            return { ok: true, consent };
          },
        })}
      />,
      wrap,
    );
    await waitFor(() => expect(screen.getByTestId('hive-beacon-toggle').textContent).toBe('off'));
    await user.click(screen.getByTestId('hive-beacon-toggle'));
    await waitFor(() => expect(screen.getByTestId('hive-beacon-toggle').textContent).toBe('on'));
    expect(calls).toEqual([['acme-hive', true]]);
  });

  it('a failed set surfaces the error inline and leaves the prior state', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    render(
      <HiveHeaderStrip
        potSlug="acme-hive"
        hiveKind="hive"
        members={[]}
        {...seams({ get: async () => false, set: async () => ({ ok: false, error: 'settings store down' }) })}
      />,
      wrap,
    );
    await waitFor(() => expect(screen.getByTestId('hive-beacon-toggle').textContent).toBe('off'));
    await user.click(screen.getByTestId('hive-beacon-toggle'));
    await screen.findByText('failed: settings store down');
    expect(screen.getByTestId('hive-beacon-toggle').textContent).toBe('off'); // unchanged
  });
});
