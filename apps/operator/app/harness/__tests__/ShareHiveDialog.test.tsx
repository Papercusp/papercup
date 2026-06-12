/**
 * @vitest-environment jsdom
 *
 * ShareHiveDialog / ShareHiveForm / PublishHiveCard — the Share-Hive surface
 * (comb-hive-native-sharing-2026-06-11 P-004). Verifies the meta prefill, the
 * visibility choice + consequence-driven submit payload, invite-secret REUSE
 * (re-minting orphans handed-out links), the recovered + freshly-minted
 * invite artifact, member-repo listing, withdraw, and failure honesty.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseHiveInviteLink } from '@papercusp/operator-core/lib/harness/hive-invite-link';
import {
  ShareHiveDialog,
  ShareHiveForm,
  type HiveShareMeta,
  type SetHiveOutcome,
} from '../ShareHiveDialog';
import { PublishHiveCard } from '../PublishHiveCard';

afterEach(() => cleanup());

const PUBKEY = 'K'.repeat(43) + '=';
const STORED_SECRET = 'deadbeef'.repeat(4); // 32 hex chars

function meta(over: Partial<HiveShareMeta> = {}): HiveShareMeta {
  return {
    hiveId: 'acme',
    found: false,
    visibility: null,
    title: 'acme',
    description: '',
    inviteSecret: null,
    hivePubkey: null,
    memberRepos: [],
    ...over,
  };
}

type SetHiveInput = {
  hiveId: string;
  title: string;
  description: string;
  visibility: 'public' | 'invite' | 'private';
  inviteSecret?: string;
};

function seams(over?: {
  meta?: HiveShareMeta | null;
  outcome?: SetHiveOutcome;
}): { calls: SetHiveInput[]; props: Record<string, unknown> } {
  const calls: SetHiveInput[] = [];
  return {
    calls,
    props: {
      fetchShareMeta: async () => over?.meta ?? meta(),
      setHiveListing: async (input: SetHiveInput) => {
        calls.push(input);
        return over?.outcome ?? { ok: true, announced: true };
      },
    },
  };
}

describe('ShareHiveForm — prefill + state (P-004)', () => {
  it('an unpublished hive: Currently unpublished, public preselected, slug prefill', async () => {
    const s = seams({ meta: meta({ found: false }) });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    await waitFor(() =>
      expect(screen.getByTestId('share-hive-current').textContent).toContain('unpublished'),
    );
    expect(screen.getByTestId('share-hive-viz-public').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('share-hive-title') as HTMLInputElement).value).toBe('acme');
  });

  it('a published hive prefills title/description and preselects the live visibility', async () => {
    const s = seams({
      meta: meta({ found: true, visibility: 'invite', title: 'Acme Hive', description: 'the stack', inviteSecret: STORED_SECRET }),
    });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    await waitFor(() =>
      expect((screen.getByTestId('share-hive-title') as HTMLInputElement).value).toBe('Acme Hive'),
    );
    expect((screen.getByTestId('share-hive-description') as HTMLTextAreaElement).value).toBe('the stack');
    expect(screen.getByTestId('share-hive-viz-invite').getAttribute('aria-pressed')).toBe('true');
  });

  it('RECOVERS the invite artifact for an already-invite hive (stored secret + pubkey + title)', async () => {
    const s = seams({
      meta: meta({ found: true, visibility: 'invite', title: 'Acme Hive', inviteSecret: STORED_SECRET, hivePubkey: PUBKEY }),
    });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    const link = (await screen.findByTestId('share-hive-invite-link')).textContent!;
    expect(parseHiveInviteLink(link)).toEqual({
      secret: STORED_SECRET,
      pubkeyBase64: PUBKEY,
      title: 'Acme Hive',
    });
  });

  it('lists the member repos that will be listed, stripping the #id suffix for display', async () => {
    const s = seams({ meta: meta({ memberRepos: ['acme/web#11', 'acme/api'] }) });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    await screen.findByTestId('share-hive-repos');
    expect(screen.getByText(/will be listed \(2\)/)).toBeTruthy();
    expect(screen.getByText('acme/web')).toBeTruthy();
    expect(screen.getByText('acme/api')).toBeTruthy();
  });

  it('flips the member-repo copy to "unlisted" when private is selected', async () => {
    const user = userEvent.setup();
    const s = seams({ meta: meta({ memberRepos: ['acme/web'] }) });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    await screen.findByTestId('share-hive-repos');
    await user.click(screen.getByTestId('share-hive-viz-private'));
    expect(screen.getByText(/will be unlisted \(1\)/)).toBeTruthy();
  });
});

describe('ShareHiveForm — submit (P-004)', () => {
  it('publishes public with the edited title + description and NO inviteSecret', async () => {
    const user = userEvent.setup();
    const s = seams({ meta: meta({ found: false }) });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    await screen.findByTestId('share-hive-current');
    await user.clear(screen.getByTestId('share-hive-title'));
    await user.type(screen.getByTestId('share-hive-title'), 'Acme Hive');
    await user.type(screen.getByTestId('share-hive-description'), 'the stack');
    await user.click(screen.getByTestId('share-hive-submit'));
    await screen.findByText('Published and announced to the directory.');
    expect(s.calls).toEqual([
      { hiveId: 'acme', title: 'Acme Hive', description: 'the stack', visibility: 'public' },
    ]);
  });

  it('invite with NO stored secret MINTS one and hands out the full artifact', async () => {
    const user = userEvent.setup();
    const s = seams({ meta: meta({ found: false, hivePubkey: PUBKEY }) });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    await screen.findByTestId('share-hive-current');
    await user.click(screen.getByTestId('share-hive-viz-invite'));
    await user.click(screen.getByTestId('share-hive-submit'));
    const link = (await screen.findByTestId('share-hive-invite-link')).textContent!;
    const minted = s.calls[0].inviteSecret!;
    expect(minted).toMatch(/^[0-9a-f]{48}$/);
    expect(parseHiveInviteLink(link)).toEqual({
      secret: minted,
      pubkeyBase64: PUBKEY,
      title: 'acme',
    });
  });

  it('invite with a STORED secret reuses it — never re-mints (links stay valid)', async () => {
    const user = userEvent.setup();
    const s = seams({
      meta: meta({ found: true, visibility: 'public', inviteSecret: STORED_SECRET }),
    });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    await screen.findByTestId('share-hive-current');
    await user.click(screen.getByTestId('share-hive-viz-invite'));
    await user.click(screen.getByTestId('share-hive-submit'));
    await screen.findByTestId('share-hive-invite-link');
    expect(s.calls[0].inviteSecret).toBe(STORED_SECRET);
  });

  it('withdraw drives visibility:private and reports the withdrawal', async () => {
    const user = userEvent.setup();
    const s = seams({
      meta: meta({ found: true, visibility: 'public' }),
      outcome: { ok: true, withdrawn: true },
    });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    await screen.findByTestId('share-hive-current');
    await user.click(screen.getByTestId('share-hive-viz-private'));
    expect(screen.getByTestId('share-hive-submit').textContent).toBe('Withdraw from directory');
    await user.click(screen.getByTestId('share-hive-submit'));
    await screen.findByText(/Withdrawn — the hive is no longer shared\./);
    expect(s.calls[0].visibility).toBe('private');
    expect(s.calls[0].inviteSecret).toBeUndefined();
  });

  it('a failed save surfaces the error and hands out NO invite link', async () => {
    const user = userEvent.setup();
    const s = seams({ meta: meta({ found: false }), outcome: { ok: false, error: 'directory down' } });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    await screen.findByTestId('share-hive-current');
    await user.click(screen.getByTestId('share-hive-viz-invite'));
    await user.click(screen.getByTestId('share-hive-submit'));
    await screen.findByText('Failed: directory down');
    expect(screen.queryByTestId('share-hive-invite-link')).toBeNull();
  });

  it('fires onSaved with the saved visibility (the chrome refresh hook)', async () => {
    const user = userEvent.setup();
    const saved: string[] = [];
    const s = seams({ meta: meta({ found: false }) });
    render(<ShareHiveForm hiveSlug="acme" onSaved={(v) => saved.push(v)} {...s.props} />);
    await screen.findByTestId('share-hive-current');
    await user.click(screen.getByTestId('share-hive-submit'));
    await waitFor(() => expect(saved).toEqual(['public']));
  });

  it('the invite-link copy button puts the artifact on the clipboard', async () => {
    const user = userEvent.setup();
    const s = seams({
      meta: meta({ found: true, visibility: 'invite', inviteSecret: STORED_SECRET }),
    });
    render(<ShareHiveForm hiveSlug="acme" {...s.props} />);
    const link = (await screen.findByTestId('share-hive-invite-link')).textContent!;
    await user.click(screen.getByTestId('share-hive-invite-copy'));
    expect(await window.navigator.clipboard.readText()).toBe(link);
    await screen.findByText('copied');
  });
});

describe('ShareHiveDialog (P-004)', () => {
  it('renders the form in a modal when open, with the lexicon label in the heading', async () => {
    const s = seams({ meta: meta({ found: false }) });
    render(
      <ShareHiveDialog hiveSlug="acme" hiveLabel="pot" open onOpenChange={() => {}} {...s.props} />,
    );
    await screen.findByTestId('share-hive-form');
    expect(screen.getByRole('heading', { name: /Share pot/ })).toBeTruthy();
  });

  it('renders nothing when closed', () => {
    const s = seams();
    render(
      <ShareHiveDialog hiveSlug="acme" open={false} onOpenChange={() => {}} {...s.props} />,
    );
    expect(screen.queryByTestId('share-hive-form')).toBeNull();
  });
});

describe('PublishHiveCard — the picker share-offer embed (P-004)', () => {
  it('embeds the compact share form with the full visibility choice (no one-click default-public)', async () => {
    const s = seams({ meta: meta({ found: false }) });
    render(<PublishHiveCard hiveSlug="acme" {...s.props} />);
    screen.getByTestId('publish-hive-card');
    await screen.findByTestId('share-hive-form');
    // The explicit choice replaced the one-click: all three options present,
    // nothing auto-published.
    screen.getByTestId('share-hive-viz-public');
    screen.getByTestId('share-hive-viz-invite');
    screen.getByTestId('share-hive-viz-private');
    expect(s.calls).toEqual([]);
  });
});
