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
