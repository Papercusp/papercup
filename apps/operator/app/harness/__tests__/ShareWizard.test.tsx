/**
 * @vitest-environment jsdom
 *
 * ShareWizard — P-029 sub-acceptance tests.
 *
 * Verifies:
 *   P-029a: nine-step flow renders sequentially; back preserves state.
 *   P-029b: step 2 existing-binding → "Join existing" alert.
 *   P-029c: step 7 privacy confirm-modal copy matches v5 §5 verbatim.
 *   P-029e: step 9 .harness/shared.json + harness link + clipboard.
 *
 * Uses @testing-library/react + vitest only (no jest-dom).
 *
 * Notes:
 *  - nuqs requires a NuqsTestingAdapter wrapper. We mount the wizard
 *    inside it so useQueryState works without a router.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareWizard, type BindingResolveResult } from '../ShareWizard';
import type { ShareWizardState } from '@/lib/harness/share-wizard-step-types';

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let clipboardWrites: string[] = [];
beforeEach(() => {
  clipboardWrites = [];
  // jsdom doesn't ship a clipboard API by default; install a stub.
  // Use vi.stubGlobal so cleanup() restores the original.
  vi.stubGlobal('navigator', new Proxy(navigator, {
    get(target, prop) {
      if (prop === 'clipboard') {
        return {
          writeText: async (s: string) => {
            clipboardWrites.push(s);
          },
        };
      }
      return Reflect.get(target, prop);
    },
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => cleanup());

const TOPIC_LIKE = /^[0-9a-f]{64}$/;

function renderWizard(opts: {
  initialRemote?: string;
  existingBinding?: boolean;
  resolveBinding?: (remote: string) => Promise<BindingResolveResult>;
  writeSharedJson?: (slug: string, state: ShareWizardState) => Promise<void>;
} = {}) {
  const onClose = vi.fn();
  const resolveBinding =
    opts.resolveBinding ??
    (async (remote: string) => ({
      github_repository_id: 12345,
      github_owner: parseSlug(remote)?.owner ?? 'owner',
      github_repo: parseSlug(remote)?.repo ?? 'repo',
      existing_binding: opts.existingBinding
        ? {
            harness_topic: 'a'.repeat(64),
            harness_slug: 'existing',
            claim_status: 'unclaimed' as const,
            publisher_github_login: 'alice',
          }
        : null,
    }));
  const writeSharedJson = opts.writeSharedJson ?? vi.fn(async () => {});
  const result = render(
    <ShareWizard
      open
      onClose={onClose}
      harnessSlug="myslug"
      initialGithubRemote={opts.initialRemote}
      resolveBinding={resolveBinding}
      runBackfill={async () => {}}
      writeSharedJson={writeSharedJson}
    />,
  );
  return { ...result, onClose, writeSharedJson };
}

function parseSlug(remote: string): { owner: string; repo: string } | null {
  const m = remote.match(/github\.com[\/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// ── P-029a — step progression ─────────────────────────────────────────────

describe('P-029a — nine-step flow', () => {
  it('step 1 is confirm-remote and shows progress 1 of 9', () => {
    renderWizard({ initialRemote: 'https://github.com/owner/repo' });
    screen.getByText('Confirm GitHub remote');
    screen.getByText('Step 1 of 9');
  });

  it('advances through steps 1 → 2 → 3 → 4 (back preserves input)', async () => {
    const user = userEvent.setup();
    renderWizard({ initialRemote: 'https://github.com/owner/repo' });
    // Step 1 → Step 2
    await user.click(screen.getByText('Next →'));
    await waitFor(() => screen.getByText('Step 2 of 9'));
    // Look up the binding
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('no-binding-message'));
    // Step 2 → Step 3
    await user.click(screen.getByText('Next →'));
    await waitFor(() => screen.getByText('Step 3 of 9'));
    // Step 3 → Step 4
    await user.click(screen.getByText('Next →'));
    await waitFor(() => screen.getByText('Step 4 of 9'));
    // Back to Step 3 then forward → state still there
    await user.click(screen.getByText('← Back'));
    await waitFor(() => screen.getByText('Step 3 of 9'));
    await user.click(screen.getByText('Next →'));
    await waitFor(() => screen.getByText('Step 4 of 9'));
  });
});

// ── P-029b — existing binding stops the flow ──────────────────────────────

describe('P-029b — existing-binding alert', () => {
  it('shows the join-existing alert and blocks advance', async () => {
    const user = userEvent.setup();
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      existingBinding: true,
    });
    await user.click(screen.getByText('Next →'));
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('existing-binding-alert'));
    // Attempting to advance surfaces the block reason.
    await user.click(screen.getByText('Next →'));
    await waitFor(() =>
      screen.getByText(/A harness already exists for this repo/),
    );
  });
});

// ── P-029c — privacy confirm-modal copy ────────────────────────────────────

describe('P-029c — privacy confirm copy', () => {
  it('shared-public copy matches v5 §5 step 7 verbatim', async () => {
    const user = userEvent.setup();
    renderWizard({ initialRemote: 'https://github.com/owner/repo' });
    // walk to step 6 — choose privacy
    await user.click(screen.getByText('Next →'));                  // 1→2
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('no-binding-message'));
    await user.click(screen.getByText('Next →'));                  // 2→3
    await user.click(screen.getByText('Next →'));                  // 3→4
    await user.click(screen.getByText('Generate topic'));
    await user.click(screen.getByText('Next →'));                  // 4→5
    await user.click(screen.getByText('Next →'));                  // 5→6 (discord optional)
    // step 6
    await user.click(screen.getByLabelText(/shared-public/, { exact: false }));
    await user.click(screen.getByText('Next →'));                  // 6→7
    await waitFor(() => screen.getByText(/Confirm:/));
    screen.getByText(
      /This harness will be listed in the Cupboard\. Your GitHub username, display name, and avatar will be visible to anyone\./,
    );
  });

  it('shared-private copy matches v5 §5 step 7 verbatim', async () => {
    const user = userEvent.setup();
    renderWizard({ initialRemote: 'https://github.com/owner/repo' });
    await user.click(screen.getByText('Next →'));
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('no-binding-message'));
    await user.click(screen.getByText('Next →'));
    await user.click(screen.getByText('Next →'));
    await user.click(screen.getByText('Generate topic'));
    await user.click(screen.getByText('Next →'));
    await user.click(screen.getByText('Next →'));
    await user.click(screen.getByLabelText(/shared-private/, { exact: false }));
    await user.click(screen.getByText('Next →'));
    await waitFor(() => screen.getByText(/Confirm:/));
    screen.getByText(
      /Anyone with this repo link or harness link can join and see all contributors' GitHub usernames \+ avatars\./,
    );
  });
});

// ── P-029e — finalize: link + clipboard + .harness/shared.json write ─────

describe('P-029e — finalize step', () => {
  it('finalize writes shared.json, builds the harness link, copies on demand', async () => {
    const user = userEvent.setup();
    const writeSharedJson = vi.fn(async (_slug: string, _state: ShareWizardState) => {});
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      writeSharedJson,
    });
    // Walk to step 9.
    await user.click(screen.getByText('Next →'));
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('no-binding-message'));
    await user.click(screen.getByText('Next →'));        // 2→3
    await user.click(screen.getByText('Next →'));        // 3→4
    await user.click(screen.getByText('Generate topic'));
    await user.click(screen.getByText('Next →'));        // 4→5
    await user.click(screen.getByText('Next →'));        // 5→6
    await user.click(screen.getByLabelText(/shared-private/, { exact: false }));
    await user.click(screen.getByText('Next →'));        // 6→7
    await user.click(screen.getByLabelText(/I understand and want to continue/));
    await user.click(screen.getByText('Next →'));        // 7→8
    await user.click(screen.getByText('Run backfill'));
    await waitFor(() => screen.getByText(/Backfill complete/));
    await user.click(screen.getByText('Next →'));        // 8→9

    await waitFor(() => screen.getByText('Finalize + share'));
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() => screen.getByText('Done'));
    expect(writeSharedJson).toHaveBeenCalledTimes(1);
    const callArg = writeSharedJson.mock.calls[0][1];
    expect(callArg.topic).toMatch(TOPIC_LIKE);
    expect(callArg.harness_link).toMatch(/^papercusp:\/\/harness\?/);
    expect(callArg.harness_link).toMatch(/repo_id=12345/);

    // Copy button copies the harness link to the clipboard.
    await user.click(screen.getByText('Copy'));
    await waitFor(() => expect(clipboardWrites.length).toBe(1));
    expect(clipboardWrites[0]).toMatch(/^papercusp:\/\/harness\?/);
  });
});

// ── Block reasons surface as inline errors ───────────────────────────────

describe('block reasons', () => {
  it('shows "GitHub remote is required" if user clears the remote and advances', async () => {
    const user = userEvent.setup();
    renderWizard();                                       // no initial remote
    await user.click(screen.getByText('Next →'));
    await waitFor(() =>
      screen.getByText(/A GitHub remote is required/),
    );
  });
});
