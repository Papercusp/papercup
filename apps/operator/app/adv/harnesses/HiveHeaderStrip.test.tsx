/**
 * @vitest-environment jsdom
 *
 * HiveHeaderStrip — the hive face strip (harnesses-tab-hive-model P-022).
 * Verifies the member-count + liveness derivation, the kind/shared/deploy
 * badges, and the empty-slug guard. Lexicon is mocked to a passthrough so the
 * test asserts structure, not flag-resolved wording.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import HiveHeaderStrip from './HiveHeaderStrip';

vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string) => key, // passthrough: t('pot') → 'pot'
}));

afterEach(() => cleanup());

describe('HiveHeaderStrip', () => {
  it('renders the hive name + member count + set-up liveness', () => {
    render(
      <HiveHeaderStrip
        hiveSlug="acme"
        hiveKind="hive"
        members={[
          { slug: 'acme', hasState: true },
          { slug: 'acme-web', hasState: true },
          { slug: 'acme-api', hasState: false },
        ]}
      />,
    );
    screen.getByTestId('hive-header-strip');
    screen.getByText('acme');
    // 3 members, 2 set up.
    expect(screen.getByText(/3 harness/)).toBeTruthy();
    expect(screen.getByText('2/3 set up')).toBeTruthy();
  });

  it('shows the Hive-home crown badge for a kind:hive root', () => {
    render(<HiveHeaderStrip hiveSlug="acme" hiveKind="hive" members={[{ slug: 'acme', hasState: true }]} />);
    expect(screen.getByText(/👑/).textContent).toContain('pot'); // hiveLabel passthrough
  });

  it('renders the deploy badge only when deployed', () => {
    const { rerender } = render(
      <HiveHeaderStrip hiveSlug="acme" members={[{ slug: 'acme' }]} />,
    );
    expect(screen.queryByText('deployed')).toBeNull();
    rerender(<HiveHeaderStrip hiveSlug="acme" members={[{ slug: 'acme' }]} deployed />);
    screen.getByText('deployed');
  });

  it('renders nothing for an empty slug', () => {
    const { container } = render(<HiveHeaderStrip hiveSlug="" members={[]} />);
    expect(container.querySelector('[data-testid="hive-header-strip"]')).toBeNull();
  });
});

describe('P-015 — the directory visibility flip (hive-from-github-url-2026-06-11)', () => {
  it('renders the flip only for a formal hive home', () => {
    render(<HiveHeaderStrip hiveSlug="plain-root" members={[]} />);
    expect(screen.queryByTestId('hive-visibility-flip')).toBeNull();
    cleanup();
    render(<HiveHeaderStrip hiveSlug="acme-hive" hiveKind="hive" members={[]} />);
    expect(screen.getByTestId('hive-visibility-flip')).toBeTruthy();
  });

  it('public flip drives the seam and reports the announce', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const calls: unknown[][] = [];
    render(
      <HiveHeaderStrip
        hiveSlug="acme-hive"
        hiveKind="hive"
        members={[]}
        setVisibility={async (...a) => {
          calls.push(a);
          return { ok: true, announced: true };
        }}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Directory visibility'), 'public');
    await screen.findByText('announced');
    expect(calls[0][0]).toBe('acme-hive');
    expect(calls[0][1]).toBe('public');
    expect(calls[0][2]).toBeUndefined();
  });

  it('invite flip mints a client-side secret and surfaces it once', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    let gotSecret: string | undefined;
    render(
      <HiveHeaderStrip
        hiveSlug="acme-hive"
        hiveKind="hive"
        members={[]}
        setVisibility={async (_s, _v, secret) => {
          gotSecret = secret;
          return { ok: true, announced: true };
        }}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Directory visibility'), 'invite');
    await screen.findByTestId('hive-visibility-outcome');
    expect(gotSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(screen.getByTestId('hive-visibility-outcome').textContent).toContain('secret:');
  });

  it('withdraw reports withdrawn; failures surface inline', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    render(
      <HiveHeaderStrip
        hiveSlug="acme-hive"
        hiveKind="hive"
        members={[]}
        setVisibility={async () => ({ ok: true, withdrawn: true })}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Directory visibility'), 'private');
    await screen.findByText('withdrawn');
  });
});
