/**
 * @vitest-environment jsdom
 *
 * ShareWizard — P-029 sub-acceptance tests.
 *
 * Verifies:
 *   P-029a: nine-step flow renders sequentially; back preserves state.
 *   P-029b: step 2 existing-binding → "Join existing" alert.
 *   P-029c: step 7 privacy confirm-modal copy matches v5 §5 verbatim.
 *   P-029e: step 9 .papercusp/shared.json + harness link + clipboard.
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
import type { ShareWizardState } from '@papercusp/operator-core/lib/harness/share-wizard-step-types';
import type { FinalizeShareResult } from '@papercusp/operator-core/lib/endpoint-route/routes/harness/share-finalize';

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
  repoPrivate?: boolean;
  resolveBinding?: (remote: string) => Promise<BindingResolveResult>;
  writeSharedJson?: (slug: string, state: ShareWizardState) => Promise<FinalizeShareResult | void>;
  publishToCupboard?: (input: unknown) => Promise<void>;
} = {}) {
  const onClose = vi.fn();
  const resolveBinding =
    opts.resolveBinding ??
    (async (remote: string) => ({
      github_repository_id: 12345,
      github_owner: parseSlug(remote)?.owner ?? 'owner',
      github_repo: parseSlug(remote)?.repo ?? 'repo',
      private: opts.repoPrivate ?? false,
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
  const publishToCupboard = opts.publishToCupboard ?? vi.fn(async () => {});
  const result = render(
    <ShareWizard
      open
      onClose={onClose}
      harnessSlug="myslug"
      initialGithubRemote={opts.initialRemote}
      resolveBinding={resolveBinding}
      runBackfill={async () => {}}
      writeSharedJson={writeSharedJson}
      publishToCupboard={publishToCupboard as never}
    />,
  );
  return { ...result, onClose, writeSharedJson, publishToCupboard };
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

// ── private-repo × shared-public gate (early detection, not at finalize) ───

describe('private repo disables shared-public at the privacy step', () => {
  it('on a PRIVATE repo, shared-public is disabled + a warning shows at step 6', async () => {
    const user = userEvent.setup();
    renderWizard({ initialRemote: 'https://github.com/owner/repo', repoPrivate: true });
    await user.click(screen.getByText('Next →')); // 1 → 2
    await waitFor(() => screen.getByText('Step 2 of 9'));
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('no-binding-message'));
    await user.click(screen.getByText('Next →')); // 2 → 3
    await waitFor(() => screen.getByText('Step 3 of 9'));
    await user.click(screen.getByText('Next →')); // 3 → 4
    await waitFor(() => screen.getByText('Step 4 of 9'));
    await user.click(screen.getByText('Generate topic')); // set topic so Next unblocks
    await user.click(screen.getByText('Next →')); // 4 → 5
    await waitFor(() => screen.getByText('Step 5 of 9'));
    await user.click(screen.getByText('Next →')); // 5 → 6 (choose-privacy)
    await waitFor(() => screen.getByText('Step 6 of 9'));

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2); // [shared-private, shared-public]
    expect(radios[0].disabled).toBe(false); // shared-private is fine on a private repo
    expect(radios[1].disabled).toBe(true); // shared-public blocked — caught here, not at finalize
    expect(screen.getByText(/PRIVATE on GitHub/i)).toBeTruthy();
  });
});

// ── private-repo offer at the URL/lookup step (step 2) ────────────────────

describe('private-repo offer at the lookup step (explain + flip to private)', () => {
  it('on a PRIVATE repo, step 2 explains the issue + offers "Share as a private harness"', async () => {
    const user = userEvent.setup();
    renderWizard({ initialRemote: 'https://github.com/owner/repo', repoPrivate: true });
    await user.click(screen.getByText('Next →')); // 1 → 2
    await waitFor(() => screen.getByText('Step 2 of 9'));
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('private-repo-offer'));
    expect(screen.getByText(/can only be shared privately/i)).toBeTruthy();
    screen.getByText('Share as a private harness →');
    screen.getByText('Cancel');
  });

  it('on a PUBLIC repo, no private-repo offer shows at step 2', async () => {
    const user = userEvent.setup();
    renderWizard({ initialRemote: 'https://github.com/owner/repo', repoPrivate: false });
    await user.click(screen.getByText('Next →')); // 1 → 2
    await waitFor(() => screen.getByText('Step 2 of 9'));
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('no-binding-message'));
    expect(screen.queryByTestId('private-repo-offer')).toBeNull();
  });

  it('"Share as a private harness" flips to shared-private + advances (private pre-selected at step 6)', async () => {
    const user = userEvent.setup();
    renderWizard({ initialRemote: 'https://github.com/owner/repo', repoPrivate: true });
    await user.click(screen.getByText('Next →')); // 1 → 2
    await waitFor(() => screen.getByText('Step 2 of 9'));
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('private-repo-offer'));
    await user.click(screen.getByText('Share as a private harness →')); // flip + advance
    await waitFor(() => screen.getByText('Step 3 of 9'));
    // Walk to the privacy step — shared-private must be pre-selected by the flip.
    await user.click(screen.getByText('Next →')); // 3 → 4
    await waitFor(() => screen.getByText('Step 4 of 9'));
    await user.click(screen.getByText('Generate topic'));
    await user.click(screen.getByText('Next →')); // 4 → 5
    await waitFor(() => screen.getByText('Step 5 of 9'));
    await user.click(screen.getByText('Next →')); // 5 → 6
    await waitFor(() => screen.getByText('Step 6 of 9'));
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios[0].checked).toBe(true); // shared-private pre-selected
    expect(radios[1].disabled).toBe(true); // shared-public still blocked
  });

  it('"Cancel" closes the wizard', async () => {
    const user = userEvent.setup();
    const { onClose } = renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      repoPrivate: true,
    });
    await user.click(screen.getByText('Next →')); // 1 → 2
    await waitFor(() => screen.getByText('Step 2 of 9'));
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('private-repo-offer'));
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
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

// ── P-069c — existing-binding alert surfaces claim status ──────────────────

describe('P-069c — existing-binding alert shows claimed/unclaimed status', () => {
  it('unclaimed existing binding → surfaces provisional owner + status badge', async () => {
    const user = userEvent.setup();
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      existingBinding: true, // fixture default: unclaimed, publisher alice
    });
    await user.click(screen.getByText('Next →'));
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('existing-binding-alert'));
    const status = screen.getByTestId('existing-binding-status');
    expect(status.textContent).toMatch(/unclaimed/i);
    expect(status.textContent).toMatch(/@alice/);
    // The ClaimStatusBadge renders inside the alert.
    expect(screen.getByTestId('claim-status-badge-unclaimed')).toBeTruthy();
  });

  it('claimed existing binding → surfaces "claimed by @bob" + claimed badge', async () => {
    const user = userEvent.setup();
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      resolveBinding: async () => ({
        github_repository_id: 12345,
        github_owner: 'owner',
        github_repo: 'repo',
        private: false,
        existing_binding: {
          harness_topic: 'a'.repeat(64),
          harness_slug: 'existing',
          claim_status: 'claimed' as const,
          publisher_github_login: 'bob',
        },
      }),
    });
    await user.click(screen.getByText('Next →'));
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('existing-binding-alert'));
    const status = screen.getByTestId('existing-binding-status');
    expect(status.textContent).toMatch(/claimed/i);
    expect(status.textContent).toMatch(/@bob/);
    expect(screen.getByTestId('claim-status-badge-claimed')).toBeTruthy();
  });
});

// ── P-069d — provisional-owner explainer fires on first share-create ───────

describe('P-069d — provisional-owner explainer on first share-create', () => {
  beforeEach(() => {
    // Fresh machine — explainer not yet seen.
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* ignore */
    }
  });

  it('fires the explainer after finalizing a NEW binding (no existing binding)', async () => {
    const user = userEvent.setup();
    renderWizard({ initialRemote: 'https://github.com/owner/repo', existingBinding: false });
    // Walk the full nine steps to finalize.
    await user.click(screen.getByText('Next →')); // 1→2
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('no-binding-message'));
    await user.click(screen.getByText('Next →')); // 2→3
    await user.click(screen.getByText('Next →')); // 3→4
    await user.click(screen.getByText('Generate topic'));
    await user.click(screen.getByText('Next →')); // 4→5
    await user.click(screen.getByText('Next →')); // 5→6 (discord optional)
    await user.click(screen.getByLabelText(/shared-private/, { exact: false }));
    await user.click(screen.getByText('Next →')); // 6→7
    await waitFor(() => screen.getByText(/Confirm:/));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByText('Next →')); // 7→8
    await user.click(screen.getByText('Run backfill'));
    await waitFor(() => screen.getByText(/Backfill complete/));
    await user.click(screen.getByText('Next →')); // 8→9
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() => screen.getByTestId('provisional-owner-explainer'));
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

// ── P-029e — finalize: link + clipboard + .papercusp/shared.json write ─────

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

// ── P-053 — shared-public also publishes to Cupboard ──────────────────────

describe('P-053 — Cupboard publish flow', () => {
  async function walkToFinalize(user: ReturnType<typeof userEvent.setup>, privacy: 'shared-private' | 'shared-public') {
    await user.click(screen.getByText('Next →'));                  // 1→2
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByTestId('no-binding-message'));
    await user.click(screen.getByText('Next →'));                  // 2→3
    await user.click(screen.getByText('Next →'));                  // 3→4
    await user.click(screen.getByText('Generate topic'));
    await user.click(screen.getByText('Next →'));                  // 4→5
    await user.click(screen.getByText('Next →'));                  // 5→6
    await user.click(screen.getByLabelText(new RegExp(privacy)));
    await user.click(screen.getByText('Next →'));                  // 6→7
    await user.click(screen.getByLabelText(/I understand and want to continue/));
    await user.click(screen.getByText('Next →'));                  // 7→8
    await user.click(screen.getByText('Run backfill'));
    await waitFor(() => screen.getByText(/Backfill complete/));
    await user.click(screen.getByText('Next →'));                  // 8→9
    await waitFor(() => screen.getByText('Finalize + share'));
  }

  it('P-053a — shared-public triggers publishToCupboard with full payload', async () => {
    const user = userEvent.setup();
    interface CupboardArg {
      github_repository_id: number;
      github_owner: string;
      github_name: string;
      github_url: string;
      topic_hex: string;
    }
    const publishToCupboard = vi.fn(async (_input: CupboardArg) => {});
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      publishToCupboard: publishToCupboard as unknown as (input: unknown) => Promise<void>,
    });
    await walkToFinalize(user, 'shared-public');
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() => screen.getByText('Done'));
    expect(publishToCupboard).toHaveBeenCalledTimes(1);
    const arg = publishToCupboard.mock.calls[0][0];
    expect(arg.github_repository_id).toBe(12345);
    expect(arg.github_owner).toBe('owner');
    expect(arg.github_name).toBe('repo');
    expect(arg.github_url).toBe('https://github.com/owner/repo');
    expect(arg.topic_hex).toMatch(TOPIC_LIKE);
  });

  it('shared-private does NOT trigger publishToCupboard', async () => {
    const user = userEvent.setup();
    const publishToCupboard = vi.fn(async () => {});
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      publishToCupboard,
    });
    await walkToFinalize(user, 'shared-private');
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() => screen.getByText('Done'));
    expect(publishToCupboard).not.toHaveBeenCalled();
  });

  it('P-053b — Cupboard publish failure surfaces inline warning, finalize still succeeds', async () => {
    const user = userEvent.setup();
    const publishToCupboard = vi.fn(async () => { throw new Error('cupboard 503'); });
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      publishToCupboard,
    });
    await walkToFinalize(user, 'shared-public');
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() => screen.getByText('Done'));
    // Local finalize completed (Done button visible).
    // Cupboard warning shows the failure + the publish-later hint.
    const warning = await screen.findByTestId('cupboard-publish-warning');
    expect(warning.textContent).toContain('cupboard 503');
    expect(warning.textContent).toContain('publish to Cupboard later');
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

// ── P-003 (phase 11) — finalize wiring + outcome surfacing ────────────────

/** Minimal valid FinalizeShareResult for stubs (shared_config is opaque here). */
function finalizeResult(over: Partial<FinalizeShareResult> = {}): FinalizeShareResult {
  return {
    ok: true,
    shared_config: {} as FinalizeShareResult['shared_config'],
    path: '/repo/.papercusp/shared.json',
    ...over,
  };
}

/** Walk steps 1→9 (shared-private) up to the Finalize button. */
async function walkTo9(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('Next →'));                  // 1→2
  await user.click(screen.getByText('Look up binding'));
  await waitFor(() => screen.getByTestId('no-binding-message'));
  await user.click(screen.getByText('Next →'));                  // 2→3
  await user.click(screen.getByText('Next →'));                  // 3→4
  await user.click(screen.getByText('Generate topic'));
  await user.click(screen.getByText('Next →'));                  // 4→5
  await user.click(screen.getByText('Next →'));                  // 5→6
  await user.click(screen.getByLabelText(/shared-private/, { exact: false }));
  await user.click(screen.getByText('Next →'));                  // 6→7
  await user.click(screen.getByLabelText(/I understand and want to continue/));
  await user.click(screen.getByText('Next →'));                  // 7→8
  await user.click(screen.getByText('Run backfill'));
  await waitFor(() => screen.getByText(/Backfill complete/));
  await user.click(screen.getByText('Next →'));                  // 8→9
  await waitFor(() => screen.getByText('Finalize + share'));
}

describe('P-003 — default wiring POSTs { state } to the shipped finalize route', () => {
  function stubFetch(finalizeResponse: () => Response) {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u === '/api/harness/binding/resolve') {
        return new Response(
          JSON.stringify({
            github_repository_id: 4242,
            github_owner: 'owner',
            github_repo: 'repo',
            private: false,
            existing_binding: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u === '/api/harness/myslug/share/finalize') return finalizeResponse();
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch);
    return calls;
  }

  /** Render with NO resolveBinding/writeSharedJson injection — exercises the
   *  real default fetch wiring against the stubbed routes. */
  function renderDefaultWired() {
    return render(
      <ShareWizard
        open
        onClose={vi.fn()}
        harnessSlug="myslug"
        initialGithubRemote="https://github.com/owner/repo"
        runBackfill={async () => {}}
      />,
    );
  }

  it('POSTs the full wizard state (real numeric repo id) and surfaces the swarm join', async () => {
    const user = userEvent.setup();
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify(finalizeResult({ swarm: { rebooted: true, state: 'booted' } })),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    renderDefaultWired();
    await walkTo9(user);
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() => screen.getByText('Done'));

    const finalize = calls.find((c) => c.url === '/api/harness/myslug/share/finalize');
    expect(finalize).toBeTruthy();
    const state = (finalize!.body as { state: Record<string, unknown> }).state;
    expect(state.github_repository_id).toBe(4242); // the real numeric id from binding-resolve
    expect(state.github_remote).toBe('https://github.com/owner/repo');
    expect(state.privacy).toBe('shared-private');
    expect(state.topic).toMatch(TOPIC_LIKE);
    expect(state.harness_link).toMatch(/repo_id=4242/);

    // The route rebooted the substrate — the wizard says so.
    screen.getByTestId('swarm-join-ok');
    expect(screen.queryByTestId('swarm-join-warning')).toBeNull();
  });

  it('surfaces the route error body on a 4xx finalize', async () => {
    const user = userEvent.setup();
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: 'invalid shared-harness config: github_repository_id must be a positive integer',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    renderDefaultWired();
    await walkTo9(user);
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() =>
      screen.getByText(/finalize failed: 400 — invalid shared-harness config/),
    );
  });
});

describe('finalize outcome surfacing (swarm reboot + binding)', () => {
  it('reboot failure → "next operator restart" warning', async () => {
    const user = userEvent.setup();
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      writeSharedJson: async () =>
        finalizeResult({ swarm: { rebooted: false, error: 'corestore wedged' } }),
    });
    await walkTo9(user);
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() => screen.getByText('Done'));
    const warning = screen.getByTestId('swarm-join-warning');
    expect(warning.textContent).toContain('corestore wedged');
    expect(warning.textContent).toContain('next operator restart');
    expect(screen.queryByTestId('swarm-join-ok')).toBeNull();
  });

  it('binding already existed → informational note, not a warning', async () => {
    const user = userEvent.setup();
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      writeSharedJson: async () =>
        finalizeResult({
          swarm: { rebooted: true, state: 'booted' },
          binding: { created: false, already_existed: true, claim_status: 'unclaimed' },
        }),
    });
    await walkTo9(user);
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() => screen.getByText('Done'));
    screen.getByTestId('binding-already-existed');
    expect(screen.queryByTestId('binding-create-warning')).toBeNull();
  });

  it('binding-create failure + publisher attestation warning both surface', async () => {
    const user = userEvent.setup();
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      writeSharedJson: async () =>
        finalizeResult({
          swarm: { rebooted: true, state: 'booted' },
          binding: { created: false, error: 'no gh token' },
          bindingWarning: 'gh auth required — re-share after `gh auth login`',
        }),
    });
    await walkTo9(user);
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() => screen.getByText('Done'));
    expect(screen.getByTestId('binding-create-warning').textContent).toContain('no gh token');
    expect(screen.getByTestId('publisher-binding-warning').textContent).toContain('gh auth required');
  });

  it('a void writeSharedJson (legacy stub) renders no outcome lines', async () => {
    const user = userEvent.setup();
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      writeSharedJson: async () => {},
    });
    await walkTo9(user);
    await user.click(screen.getByText('Finalize + share'));
    await waitFor(() => screen.getByText('Done'));
    expect(screen.queryByTestId('swarm-join-ok')).toBeNull();
    expect(screen.queryByTestId('swarm-join-warning')).toBeNull();
  });
});

describe('repo-id guard at the lookup step', () => {
  it('rejects a 0 repository id with a visible error and blocks advance', async () => {
    const user = userEvent.setup();
    renderWizard({
      initialRemote: 'https://github.com/owner/repo',
      resolveBinding: async () => ({
        github_repository_id: 0, // the swarm keys on this — must never be stored
        github_owner: 'owner',
        github_repo: 'repo',
        private: false,
        existing_binding: null,
      }),
    });
    await user.click(screen.getByText('Next →')); // 1→2
    await user.click(screen.getByText('Look up binding'));
    await waitFor(() => screen.getByText(/invalid repository id \(0\)/));
    expect(screen.queryByTestId('no-binding-message')).toBeNull();
    // Next stays blocked — the bad id was never stored.
    await user.click(screen.getByText('Next →'));
    await waitFor(() => screen.getByText(/Look up the binding before continuing/));
  });
});
