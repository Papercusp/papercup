'use client';

/**
 * ShareWizard — share-this-harness flow per v5 §5 nine-step.
 *
 * Phase 5a P-029. Pure-UI layer on top of the types-only spine at
 * `apps/operator/lib/harness/share-wizard-step-types.ts` (state +
 * transition rules) and `harness-shared-config-types.ts` /
 * `harness-link-types.ts` (output composition).
 *
 * Backend gaps as of 2026-05-25 (deferred to follow-ups):
 *   - Step 2 binding lookup hits POST /api/harness/binding/resolve
 *     when wired (Phase 1b P-068 binding service is in tree; a thin
 *     route wrapper is the only missing piece). For now this step
 *     calls the local helper directly.
 *   - Step 3 binding creation calls the same endpoint with create=true.
 *   - Step 8 PG→Hyperbee backfill calls the Phase 5a P-031 projection
 *     seeder when wired; UI stub for now.
 *   - Step 9 .papercusp/shared.json write goes through a thin
 *     `/api/harness/:slug/share/finalize` endpoint (also follow-up);
 *     UI surfaces the link + clipboard regardless.
 *
 * Wizard navigation state is held in nuqs (per the "almost all state
 * in nuqs" rule), so back-button + reload restore the step. The wider
 * wizard state (form inputs collected so far) is held in useState
 * because it includes secrets (topic bytes) that should not live in
 * the URL.
 */

import { useCallback, useMemo, useState, useEffect, type ReactNode, type CSSProperties } from 'react';
import { Modal } from './Modal';
import { toast } from 'sonner';
import {
  ProvisionalOwnerExplainer,
  shouldShowProvisionalOwnerExplainer,
} from '../_components/ProvisionalOwnerExplainer';
import { ClaimStatusBadge } from '../_components/ClaimStatusBadge';
import {
  SHARE_WIZARD_STEPS,
  SHARE_WIZARD_FIRST_STEP,
  SHARE_WIZARD_STEP_INDEX,
  SHARE_WIZARD_STEP_COUNT,
  emptyShareWizardState,
  nextStep,
  previousStep,
  shouldOfferPrivateShare,
  flipToPrivateShare,
  type ShareWizardStep,
  type ShareWizardState,
} from '@papercusp/operator-core/lib/harness/share-wizard-step-types';
import {
  HARNESS_SHARED_PRIVACY_LEVELS,
  buildFreshConfig,
  type HarnessSharedPrivacy,
} from '@papercusp/operator-core/lib/harness/harness-shared-config-types';
import { formatHarnessLink } from '@papercusp/operator-core/lib/harness/harness-link-types';
// Type-only — the route module's runtime (defineTool, node:fs) is never pulled
// into the browser bundle; this is the response shape the finalize route returns.
import type { FinalizeShareResult } from '@papercusp/operator-core/lib/endpoint-route/routes/harness/share-finalize';

// ── Props ─────────────────────────────────────────────────────────────────

export interface ShareWizardProps {
  /** Whether the wizard modal is open. */
  open: boolean;
  /** Called when the user closes the modal (X, escape, or post-success "Done"). */
  onClose: () => void;
  /** The harness slug being shared. */
  harnessSlug: string;
  /**
   * The current viewer's GitHub login — names the provisional owner in the
   * P-069d first-share explainer. Defaults to 'you' when unknown (anonymous /
   * gh not yet resolved); the explainer copy still reads cleanly.
   */
  ownerLogin?: string;
  /**
   * Initial GitHub remote — typically pre-populated from
   * `git remote get-url origin` in the harness directory. When
   * absent, step 1 surfaces an "add a remote first" affordance.
   */
  initialGithubRemote?: string;
  /**
   * Injection point for the binding-lookup call. The default
   * implementation calls the operator's /api/harness/binding/resolve
   * route; tests pass a stub.
   */
  resolveBinding?: (remote: string) => Promise<BindingResolveResult>;
  /**
   * Backfill injection point. The default no-op stub is replaced by
   * the real PG→Hyperbee seeder when Phase 5a P-031 lands.
   */
  runBackfill?: (state: ShareWizardState) => Promise<void>;
  /**
   * .papercusp/shared.json finalize injection point. Defaults to POSTing
   * `{ state }` to `/api/harness/:slug/share/finalize` and returning the
   * route's FinalizeShareResult (swarm-reboot + binding outcomes), which the
   * final step surfaces. Tests pass a stub; a `void` return just skips the
   * outcome lines.
   */
  writeSharedJson?: (
    slug: string,
    state: ShareWizardState,
  ) => Promise<FinalizeShareResult | void>;
  /**
   * Cupboard publish injection point (P-053). Called on finalize ONLY
   * when privacy === 'shared-public'. Defaults to a fetch against
   * `${PAPERCUSP_CUPBOARD_URL}/harnesses` resolved at call time.
   * Tests pass a stub. Failures don't fail the wizard — see P-053b
   * "publish later" affordance.
   */
  publishToCupboard?: (input: CupboardPublishInput) => Promise<void>;
  /**
   * P-016 (hive-from-github-url-2026-06-11): the harness's home Hive slug when
   * it is a Hive member. Sharing happens at the HIVE level now — the wizard
   * shows a "share the hive instead" pointer card with a one-click hive
   * publish (POST /api/discovery/set-hive); this per-harness wizard remains
   * the single-harness sub-share path.
   */
  hiveSlug?: string;
  /** Injection point for the hive publish (tests). Default: POST /api/discovery/set-hive. */
  publishHive?: (hiveSlug: string) => Promise<{ ok: boolean; announced?: boolean; error?: string }>;
}

async function defaultPublishHive(
  hiveSlug: string,
): Promise<{ ok: boolean; announced?: boolean; error?: string }> {
  try {
    const res = await fetch('/api/discovery/set-hive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hiveId: hiveSlug, title: hiveSlug, visibility: 'public' }),
    });
    const body = (await res.json().catch(() => ({}))) as { announced?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, announced: body.announced };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface CupboardPublishInput {
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title?: string;
  description?: string;
  topic_hex: string;
}

export interface BindingResolveResult {
  github_repository_id: number;
  github_owner: string;
  github_repo: string;
  private: boolean;
  existing_binding: null | {
    harness_topic: string;
    harness_slug: string;
    claim_status: 'unclaimed' | 'claimed' | 'stale' | 'superseded';
    publisher_github_login: string;
  };
}

// ── 32-byte topic generation ──────────────────────────────────────────────

function generateTopic(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Styles (mirror CreateHarnessPicker pattern) ──────────────────────────

const cardStyle: CSSProperties = {
  background: 'var(--bg-2)', border: '1px solid var(--border)',
  borderRadius: 8, padding: 16, marginBottom: 12,
};
const inputStyle: CSSProperties = {
  display: 'block', width: '100%', padding: '7px 10px',
  background: 'var(--bg-2)', border: '1px solid var(--border)',
  borderRadius: 4, color: 'var(--fg)', fontSize: 14, fontFamily: 'inherit',
};
const buttonPrimary: CSSProperties = {
  padding: '8px 16px', background: 'var(--accent)', color: 'var(--accent-fg)',
  border: 0, borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: 'pointer',
};
const buttonSecondary: CSSProperties = {
  padding: '8px 16px', background: 'transparent', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 4, fontSize: 14, cursor: 'pointer',
};
/** Inline warning box on the finalize step (cupboard/swarm/binding warnings). */
const warnBoxStyle: CSSProperties = {
  marginTop: 12, padding: 10, background: 'var(--bg-warning, #4a3a1a)',
  border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, color: 'var(--fg)',
};

function FieldLabel({ children }: { children: ReactNode }) {
  return <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-dim)', marginBottom: 4, fontWeight: 500 }}>{children}</span>;
}

// ── Default injection-point implementations ──────────────────────────────

async function defaultResolveBinding(remote: string): Promise<BindingResolveResult> {
  const res = await fetch('/api/harness/binding/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ github_remote: remote }),
  });
  if (!res.ok) {
    // The route returns { error } with the real cause (unparseable remote,
    // GITHUB_API_DOWN, rate limit, …) — surface it, not just the status code.
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(
      `binding lookup failed: ${res.status}${detail?.error ? ` — ${detail.error}` : ''}`,
    );
  }
  return (await res.json()) as BindingResolveResult;
}

async function defaultRunBackfill(_state: ShareWizardState): Promise<void> {
  // Phase 5a P-031 follow-up wires the real PG→Hyperbee + GIT seeder.
  // For now, simulate a short async no-op so the UI flow exercises end-to-end.
  await new Promise((r) => setTimeout(r, 200));
}

async function defaultWriteSharedJson(
  slug: string,
  state: ShareWizardState,
): Promise<FinalizeShareResult> {
  const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/share/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) {
    // The route 4xxs with { error } (invalid config, unknown slug, …) —
    // surface the real cause, not just the status code.
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(
      `finalize failed: ${res.status}${detail?.error ? ` — ${detail.error}` : ''}`,
    );
  }
  return (await res.json()) as FinalizeShareResult;
}

/**
 * Default Cupboard publish — POSTs to the configured Cupboard URL.
 * The URL is resolved from a meta tag (`<meta name="papercusp-cupboard-url">`)
 * or falls back to the production host. Server-side authentication
 * uses the user's gh-bearer token via the operator's Cupboard proxy
 * route (the desktop operator handles credential forwarding so the
 * browser never holds the gh token).
 */
async function defaultPublishToCupboard(input: CupboardPublishInput): Promise<void> {
  // Routed through the operator so the gh token stays server-side.
  const res = await fetch('/api/harness/cupboard/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`cupboard publish failed: ${res.status} ${detail.slice(0, 120)}`);
  }
}

// ── Step header ───────────────────────────────────────────────────────────

function StepHeader({ step, label }: { step: ShareWizardStep; label: string }) {
  const idx = SHARE_WIZARD_STEP_INDEX[step];
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 2 }}>
        Step {idx} of {SHARE_WIZARD_STEP_COUNT}
      </div>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{label}</h2>
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────

export function ShareWizard(props: ShareWizardProps): ReactNode {
  const {
    open, onClose, harnessSlug, ownerLogin,
    initialGithubRemote,
    resolveBinding = defaultResolveBinding,
    runBackfill = defaultRunBackfill,
    writeSharedJson = defaultWriteSharedJson,
    publishToCupboard = defaultPublishToCupboard,
    hiveSlug,
    publishHive = defaultPublishHive,
  } = props;
  // P-016 — the hive pointer card: dismissed = the user explicitly chose the
  // single-harness sub-share. Transient per-open lifecycle → useState.
  const [hivePointerDismissed, setHivePointerDismissed] = useState(false);
  const [hivePublish, setHivePublish] = useState<
    { busy: boolean; outcome?: { ok: boolean; announced?: boolean; error?: string } }
  >({ busy: false });
  const [publishWarning, setPublishWarning] = useState<string | null>(null);
  // P-069c — the existing-binding detail (claim status + publisher) the
  // step-2 lookup found, so the alert can surface claimed/unclaimed status
  // before the user closes to join. Transient lookup metadata (not wizard
  // input that must survive back-step), so plain useState.
  const [existingBinding, setExistingBinding] =
    useState<BindingResolveResult['existing_binding']>(null);
  // P-069d — provisional-owner explainer, shown once per machine on the
  // first successful share-create.
  const [showProvisionalExplainer, setShowProvisionalExplainer] = useState(false);

  const [step, setStep] = useState<ShareWizardStep>(SHARE_WIZARD_FIRST_STEP);
  const [state, setState] = useState<ShareWizardState>(() => {
    const init = emptyShareWizardState();
    if (initialGithubRemote) init.github_remote = initialGithubRemote;
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset when the modal opens fresh (after a successful close).
  useEffect(() => {
    if (!open) {
      setErr(null);
      setBusy(false);
    }
  }, [open]);

  const advance = useCallback((override?: ShareWizardState) => {
    const t = nextStep(step, override ?? state);
    setErr(null);
    if (t.kind === 'block') {
      setErr(blockReasonCopy(t.reason));
      return;
    }
    if (t.kind === 'complete') {
      onClose();
      return;
    }
    setStep(t.step);
  }, [step, state, onClose]);

  const back = useCallback(() => {
    const prev = previousStep(step);
    if (prev) setStep(prev);
    setErr(null);
  }, [step]);

  // ── Per-step renderers ─────────────────────────────────────────────────

  function renderStep1ConfirmRemote(): ReactNode {
    return (
      <>
        <StepHeader step="confirm-remote" label="Confirm GitHub remote" />
        <div style={cardStyle}>
          <FieldLabel>git remote URL</FieldLabel>
          <input
            style={inputStyle}
            type="text"
            placeholder="https://github.com/owner/repo"
            value={state.github_remote ?? ''}
            onChange={(e) => setState((s) => ({ ...s, github_remote: e.target.value.trim() }))}
            autoFocus
          />
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-dim)' }}>
            Detected from <code>git remote get-url origin</code>. If empty, add a GitHub remote first, then come back.
          </div>
        </div>
      </>
    );
  }

  async function lookupBinding(): Promise<void> {
    if (!state.github_remote) return;
    setBusy(true); setErr(null);
    try {
      const r = await resolveBinding(state.github_remote);
      // Boot keys the swarm on github_repository_id (derive-swarm-topic) and
      // the finalize route 400s on a non-positive id — refuse a 0/NaN id HERE
      // with a visible error rather than storing it and dead-ending at step 9
      // behind a silently-disabled Finalize button.
      if (!Number.isInteger(r.github_repository_id) || r.github_repository_id <= 0) {
        throw new Error(
          `binding lookup returned an invalid repository id (${String(r.github_repository_id)}) — check the remote URL and try again`,
        );
      }
      setExistingBinding(r.existing_binding);
      setState((s) => ({
        ...s,
        github_repository_id: r.github_repository_id,
        existing_binding_found: r.existing_binding !== null,
        repo_private: r.private, // captured at step 2 → gates shared-public at step 6
      }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function renderStep2LookupBinding(): ReactNode {
    const looked = state.github_repository_id !== undefined;
    return (
      <>
        <StepHeader step="lookup-binding" label="Resolve canonical repo binding" />
        <div style={cardStyle}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            <code>{state.github_remote}</code>
          </div>
          {!looked && (
            <button style={buttonPrimary} disabled={busy} onClick={() => void lookupBinding()}>
              {busy ? 'Looking up…' : 'Look up binding'}
            </button>
          )}
          {looked && state.existing_binding_found && (
            <div data-testid="existing-binding-alert" style={{ ...cardStyle, background: 'var(--bg-warning, #4a2a1a)', borderColor: 'var(--border-warning, #b45a32)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <strong>Existing harness found</strong>
                {existingBinding && (
                  <ClaimStatusBadge
                    status={existingBinding.claim_status}
                    claimantLogin={existingBinding.publisher_github_login}
                  />
                )}
              </div>
              {existingBinding && (
                <div data-testid="existing-binding-status" style={{ fontSize: 13, marginBottom: 6 }}>
                  {existingBinding.claim_status === 'claimed'
                    ? <>This repo's harness is <strong>claimed</strong> by <strong>@{existingBinding.publisher_github_login}</strong>.</>
                    : existingBinding.claim_status === 'stale'
                    ? <>This repo's harness has a <strong>stale claim</strong> — the last claimant lost their GitHub permission.</>
                    : existingBinding.claim_status === 'superseded'
                    ? <>This repo's harness has been <strong>superseded</strong> by a newer binding.</>
                    : <>This repo's harness is <strong>unclaimed</strong>; <strong>@{existingBinding.publisher_github_login}</strong> is the provisional owner.</>}
                </div>
              )}
              A shared harness already exists for this repo. You should join it rather than create a duplicate. Close this wizard and use the harness link from the existing publisher.
            </div>
          )}
          {looked && !state.existing_binding_found && (
            <div data-testid="no-binding-message" style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
              No binding found for repository_id {state.github_repository_id}. Ready to create one.
            </div>
          )}
          {looked && !state.existing_binding_found && shouldOfferPrivateShare(state) && (
            <div
              data-testid="private-repo-offer"
              style={{ ...cardStyle, marginTop: 12, marginBottom: 0, background: 'var(--bg-warning, #4a2a1a)', borderColor: 'var(--border-warning, #b45a32)' }}
            >
              <div style={{ marginBottom: 6 }}>
                <strong>⚠ This repository is private on GitHub</strong>
              </div>
              <div style={{ fontSize: 13, marginBottom: 12 }}>
                A public harness is listed on the public Cupboard registry, which
                can’t list a private repo — so this can only be shared privately.
                <br />
                <span style={{ color: 'var(--fg-dim)' }}>
                  (To share publicly, make the repo public on GitHub first, then re-run Share.)
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  style={buttonPrimary}
                  disabled={busy}
                  onClick={() => {
                    // Flip the whole flow to the private workflow, then advance —
                    // pass the flipped state to advance() so it transitions on the
                    // post-flip state, not the pre-flip `state` from its closure
                    // (robust even if a future step's transition reads `privacy`).
                    const flipped = flipToPrivateShare(state);
                    setState(flipped);
                    advance(flipped);
                  }}
                >
                  Share as a private harness →
                </button>
                <button style={buttonSecondary} disabled={busy} onClick={() => onClose()}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  function renderStep3CreateBinding(): ReactNode {
    return (
      <>
        <StepHeader step="create-binding" label="You'll be the provisional owner" />
        <div style={cardStyle}>
          <p style={{ marginTop: 0 }}>
            No one has created a Papercusp shared harness for this repo yet. You will become the <strong>provisional owner</strong>.
          </p>
          <p>
            While unclaimed, you can manage: harness title/description/tags, shared-private vs shared-public visibility, Cupboard listing metadata, Discord channel/webhook, default sync/peer-mirror policy, and contributor-facing welcome text.
          </p>
          <p style={{ marginBottom: 0 }}>
            A GitHub maintainer/owner can claim this harness later and will then control those owner-level settings.
          </p>
        </div>
      </>
    );
  }

  function renderStep4GenerateTopic(): ReactNode {
    const ensureTopic = () => {
      setState((s) => (s.topic ? s : { ...s, topic: generateTopic() }));
    };
    return (
      <>
        <StepHeader step="generate-topic" label="Generate Hyperswarm topic" />
        <div style={cardStyle}>
          <p style={{ marginTop: 0 }}>32 random bytes that become this harness's swarm key. Anyone with the topic can attempt to join.</p>
          {state.topic ? (
            <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: 12, background: 'var(--bg-1)', padding: 8, borderRadius: 4 }}>
              {state.topic}
            </div>
          ) : (
            <button style={buttonPrimary} onClick={ensureTopic}>Generate topic</button>
          )}
        </div>
      </>
    );
  }

  function renderStep5ChooseDiscord(): ReactNode {
    return (
      <>
        <StepHeader step="choose-discord" label="Discord channel (optional)" />
        <div style={cardStyle}>
          <FieldLabel>Discord channel link</FieldLabel>
          <input
            style={inputStyle}
            type="text"
            placeholder="https://discord.com/channels/123/456 (optional)"
            value={state.discord_channel ?? ''}
            onChange={(e) => setState((s) => ({ ...s, discord_channel: e.target.value.trim() || undefined }))}
          />
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-dim)' }}>
            Optional. Shows a Discord deep-link in the harness header for contributors. Leave blank to skip.
          </div>
        </div>
      </>
    );
  }

  function renderStep6ChoosePrivacy(): ReactNode {
    return (
      <>
        <StepHeader step="choose-privacy" label="Choose privacy" />
        <div style={cardStyle}>
          {HARNESS_SHARED_PRIVACY_LEVELS.map((opt) => {
            // shared-public lists on the PUBLIC Cupboard, which can't list a
            // private repo. Disable it up front (we learned visibility at step 2)
            // rather than failing the publish at finalize.
            const publicBlocked = opt === 'shared-public' && state.repo_private === true;
            return (
              <label
                key={opt}
                style={{ display: 'flex', alignItems: 'flex-start', padding: 10, borderRadius: 4, border: '1px solid var(--border)', marginBottom: 8, cursor: publicBlocked ? 'not-allowed' : 'pointer', opacity: publicBlocked ? 0.55 : 1 }}
              >
                <input
                  type="radio"
                  name="privacy"
                  checked={state.privacy === opt}
                  disabled={publicBlocked}
                  onChange={() => {
                    if (publicBlocked) return;
                    setState((s) => ({ ...s, privacy: opt as HarnessSharedPrivacy, privacy_confirmed: false }));
                  }}
                  style={{ marginTop: 3, marginRight: 10 }}
                />
                <div>
                  <strong>{opt}</strong>
                  <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 2 }}>
                    {publicBlocked
                      ? '⚠ This repo is PRIVATE on GitHub — the public Cupboard registry can’t list it. Make the repo public on GitHub to use shared-public, or choose shared-private.'
                      : opt === 'shared-private'
                        ? 'Joinable only via the harness link. Not listed publicly.'
                        : 'Listed in the public Cupboard for anyone to browse and join.'}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      </>
    );
  }

  function renderStep7PrivacyConfirm(): ReactNode {
    const copy = state.privacy === 'shared-public'
      ? 'This harness will be listed in the Cupboard. Your GitHub username, display name, and avatar will be visible to anyone.'
      : 'Anyone with this repo link or harness link can join and see all contributors\' GitHub usernames + avatars.';
    return (
      <>
        <StepHeader step="privacy-confirm" label={`Confirm: ${state.privacy ?? ''}`} />
        <div style={{ ...cardStyle, background: 'var(--bg-warning, #2a3344)' }}>
          <p style={{ marginTop: 0 }}>{copy}</p>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={state.privacy_confirmed === true}
              onChange={(e) => setState((s) => ({ ...s, privacy_confirmed: e.target.checked }))}
              style={{ marginRight: 8 }}
            />
            I understand and want to continue.
          </label>
        </div>
      </>
    );
  }

  async function runBackfillStep(): Promise<void> {
    setBusy(true); setErr(null);
    try {
      await runBackfill(state);
      setState((s) => ({ ...s, backfill_completed_ts: Date.now() }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function renderStep8Backfill(): ReactNode {
    const done = state.backfill_completed_ts !== undefined;
    return (
      <>
        <StepHeader step="backfill" label="Seed Hyperbee + GIT from PG" />
        <div style={cardStyle}>
          <p style={{ marginTop: 0 }}>One-time seeding of feature queue, contributors, and shared state from your local PG into the new shared harness's Hyperbee + GIT layers. Idempotent — safe to re-run.</p>
          {!done && (
            <button style={buttonPrimary} disabled={busy} onClick={() => void runBackfillStep()}>
              {busy ? 'Backfilling…' : 'Run backfill'}
            </button>
          )}
          {done && (
            <div style={{ color: 'var(--accent)', fontSize: 13 }}>
              ✓ Backfill complete at {new Date(state.backfill_completed_ts!).toLocaleTimeString()}.
            </div>
          )}
          {err && <div style={{ color: 'var(--error, #e64646)', fontSize: 13, marginTop: 8 }}>{err}</div>}
        </div>
      </>
    );
  }

  const finalLink = useMemo(() => {
    if (
      !state.topic ||
      !state.github_remote ||
      !state.github_repository_id
    ) return null;
    const parsed = parseGithubRemote(state.github_remote);
    if (!parsed) return null;
    try {
      return formatHarnessLink({
        topic: state.topic,
        github_owner: parsed.owner,
        github_repo: parsed.repo,
        github_repository_id: state.github_repository_id,
      });
    } catch {
      return null;
    }
  }, [state]);

  const [finalized, setFinalized] = useState(false);
  // The finalize route's rich result (swarm reboot + binding outcomes) —
  // surfaced on the final step so the user knows whether the harness actually
  // went online or still needs an operator restart. Null until finalize
  // succeeds (or when an injected writeSharedJson returns void).
  const [finalizeOutcome, setFinalizeOutcome] = useState<FinalizeShareResult | null>(null);

  async function finalizeShared(): Promise<void> {
    if (!finalLink || !state.privacy || !state.topic || !state.github_remote || !state.github_repository_id) return;
    setBusy(true); setErr(null);
    try {
      // Validate config builds (throws on invalid input).
      buildFreshConfig({
        topic: state.topic,
        github_remote: state.github_remote,
        github_repository_id: state.github_repository_id,
        privacy: state.privacy,
        discord_channel: state.discord_channel,
        now: Date.now(),
      });
      const outcome = await writeSharedJson(harnessSlug, { ...state, harness_link: finalLink });
      setFinalizeOutcome(outcome ?? null);
      setState((s) => ({ ...s, harness_link: finalLink }));
      setFinalized(true);

      // P-069d — first share-create makes the engineer the provisional owner.
      // Fire the one-time-per-machine explainer (it self-suppresses after the
      // first dismissal). Only on a NEW binding — joining an existing one
      // doesn't make you the provisional owner.
      if (!state.existing_binding_found && shouldShowProvisionalOwnerExplainer()) {
        setShowProvisionalExplainer(true);
      }

      // P-053 — shared-public also publishes to Cupboard. Best-effort:
      // a Cupboard failure does NOT roll back the local finalize. The
      // user sees an inline warning + a "publish later" affordance.
      if (state.privacy === 'shared-public') {
        const parsed = parseGithubRemote(state.github_remote);
        if (parsed) {
          try {
            await publishToCupboard({
              github_repository_id: state.github_repository_id,
              github_owner: parsed.owner,
              github_name: parsed.repo,
              github_url: state.github_remote,
              topic_hex: state.topic,
            });
            setPublishWarning(null);
          } catch (cupErr) {
            setPublishWarning(
              `Cupboard publish failed (${(cupErr as Error).message}). The harness is shared-private locally; you can publish to Cupboard later from settings.`,
            );
          }
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function renderStep9Finalize(): ReactNode {
    const copy = () => {
      if (!finalLink) return;
      void navigator.clipboard.writeText(finalLink);
      toast.success('Harness link copied to clipboard');
    };
    return (
      <>
        <StepHeader step="write-shared-json" label="Share the harness link" />
        <div style={cardStyle}>
          {!finalized && !state.harness_link && (
            <>
              <p style={{ marginTop: 0 }}>Ready to finalize. This writes <code>.papercusp/shared.json</code> (committed to git) and registers the binding.</p>
              <button style={buttonPrimary} disabled={busy || !finalLink} onClick={() => void finalizeShared()}>
                {busy ? 'Finalizing…' : 'Finalize + share'}
              </button>
              {err && <div style={{ color: 'var(--error, #e64646)', fontSize: 13, marginTop: 8 }}>{err}</div>}
            </>
          )}
          {(finalized || state.harness_link) && finalLink && (
            <>
              <FieldLabel>Harness link</FieldLabel>
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 12 }} readOnly value={finalLink} />
                <button style={buttonSecondary} onClick={copy}>Copy</button>
              </div>
              <div style={{ marginTop: 12, fontSize: 13, color: 'var(--fg-dim)' }}>
                Send this link to contributors. They paste it into Entry 4 of the create-harness picker.
              </div>
              {/* Swarm-reboot outcome — the route reboots the harness after the
                  write so an already-booted (swarm: null) handle re-resolves the
                  fresh shared.json and joins the derived topic. Tell the user
                  whether that actually happened. */}
              {finalizeOutcome?.swarm && (
                finalizeOutcome.swarm.rebooted && finalizeOutcome.swarm.state === 'booted' ? (
                  <div data-testid="swarm-join-ok" style={{ marginTop: 12, fontSize: 13, color: 'var(--accent)' }}>
                    ✓ Harness substrate rebooted — joining the swarm now.
                  </div>
                ) : (
                  <div data-testid="swarm-join-warning" style={warnBoxStyle}>
                    The share is saved, but the live swarm join didn’t complete
                    {finalizeOutcome.swarm.error ? ` (${finalizeOutcome.swarm.error})` : ''} — the
                    harness will join the swarm on the next operator restart.
                  </div>
                )
              )}
              {finalizeOutcome?.binding?.already_existed && (
                <div data-testid="binding-already-existed" style={{ marginTop: 12, fontSize: 13, color: 'var(--fg-dim)' }}>
                  A binding for this repo already existed — your share reuses it instead of creating a new one.
                </div>
              )}
              {finalizeOutcome?.binding && !finalizeOutcome.binding.created && !finalizeOutcome.binding.already_existed && (
                <div data-testid="binding-create-warning" style={warnBoxStyle}>
                  Binding registration failed
                  {finalizeOutcome.binding.error ? ` (${finalizeOutcome.binding.error})` : ''} — the
                  share works locally; re-run Share later to register the binding.
                </div>
              )}
              {finalizeOutcome?.bindingWarning && (
                <div data-testid="publisher-binding-warning" style={warnBoxStyle}>
                  Publisher attestation warning: {finalizeOutcome.bindingWarning}
                </div>
              )}
              {publishWarning && (
                <div data-testid="cupboard-publish-warning" style={warnBoxStyle}>
                  {publishWarning}
                </div>
              )}
            </>
          )}
        </div>
      </>
    );
  }

  function renderStep(): ReactNode {
    switch (step) {
      case 'confirm-remote': return renderStep1ConfirmRemote();
      case 'lookup-binding': return renderStep2LookupBinding();
      case 'create-binding': return renderStep3CreateBinding();
      case 'generate-topic': return renderStep4GenerateTopic();
      case 'choose-discord': return renderStep5ChooseDiscord();
      case 'choose-privacy': return renderStep6ChoosePrivacy();
      case 'privacy-confirm': return renderStep7PrivacyConfirm();
      case 'backfill': return renderStep8Backfill();
      case 'write-shared-json': return renderStep9Finalize();
    }
  }

  const canBack = previousStep(step) !== null;
  const isLast = step === 'write-shared-json';

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(v) => { if (!v) onClose(); }}
        title="Share this harness"
        contentStyle={{
          width: 'min(560px, 96vw)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--bg-popover, #0d1829)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
          color: 'var(--fg, #e8e8ea)',
        }}
      >
        {/* P-016 — this harness belongs to a Hive: sharing happens at the hive
            level; this wizard remains the single-harness sub-share path. */}
        {hiveSlug && !hivePointerDismissed && (
          <div
            data-testid="hive-share-pointer"
            style={{
              border: '1px solid var(--accent, #4a90d9)',
              borderRadius: 8,
              padding: 12,
              marginBottom: 16,
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              This harness is part of hive <code>{hiveSlug}</code>
            </div>
            <div style={{ color: 'var(--fg-dim)', marginBottom: 10 }}>
              Sharing now happens at the hive level — publishing the hive lists it on the
              P2P directory with all member repos, joinable in one click. Continue below
              only for a single-harness sub-share (a guest on this one repo).
            </div>
            {hivePublish.outcome ? (
              <div style={{ marginBottom: 6 }}>
                {hivePublish.outcome.ok
                  ? `Hive published${hivePublish.outcome.announced ? ' + announced to the directory' : ' (announce pending transport)'}.`
                  : `Hive publish failed: ${hivePublish.outcome.error ?? 'unknown error'}`}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                style={buttonPrimary}
                disabled={hivePublish.busy || hivePublish.outcome?.ok === true}
                onClick={() => {
                  setHivePublish({ busy: true });
                  void publishHive(hiveSlug).then((outcome) =>
                    setHivePublish({ busy: false, outcome }),
                  );
                }}
              >
                {hivePublish.busy ? 'Publishing…' : 'Publish the hive instead'}
              </button>
              <button style={buttonSecondary} onClick={() => setHivePointerDismissed(true)}>
                Continue with single-harness share
              </button>
            </div>
          </div>
        )}
        {renderStep()}
        {err && step !== 'backfill' && step !== 'write-shared-json' && (
          <div style={{ color: 'var(--error, #e64646)', fontSize: 13, marginTop: 8 }}>{err}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          <button style={buttonSecondary} disabled={!canBack} onClick={back}>← Back</button>
          {!isLast && (
            <button style={buttonPrimary} disabled={busy} onClick={() => advance()}>Next →</button>
          )}
          {isLast && finalized && (
            <button style={buttonPrimary} onClick={onClose}>Done</button>
          )}
        </div>
      </Modal>
      {/* P-069d — first-share provisional-owner explainer (one-time per machine). */}
      <ProvisionalOwnerExplainer
        open={showProvisionalExplainer}
        ownerLogin={ownerLogin ?? 'you'}
        harnessSlug={harnessSlug}
        onClose={() => setShowProvisionalExplainer(false)}
      />
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function blockReasonCopy(reason: string): string {
  switch (reason) {
    case 'no_github_remote': return 'A GitHub remote is required. Add one with `git remote add origin <url>` and come back.';
    case 'binding_lookup_pending': return 'Look up the binding before continuing.';
    case 'binding_exists_should_join': return 'A harness already exists for this repo. Close the wizard and use the existing harness link.';
    case 'topic_not_generated': return 'Generate the topic first.';
    case 'privacy_not_chosen': return 'Pick shared-private or shared-public.';
    case 'privacy_not_confirmed': return 'Confirm the privacy implications before continuing.';
    case 'backfill_not_completed': return 'Run the backfill first.';
    default: return reason;
  }
}

function parseGithubRemote(remote: string): { owner: string; repo: string } | null {
  // Handle https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git)
  const httpsMatch = remote.match(/github\.com[\/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!httpsMatch) return null;
  return { owner: httpsMatch[1], repo: httpsMatch[2] };
}
