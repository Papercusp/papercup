'use client';

/**
 * BootstrapFinishGate — the setup-finish gate view for the "Papercusp dogfood
 * hive clone-on-first-boot" (desktop UI part B). Rendered by SetupWizard in
 * place of the recap when the user hits Finish but the dogfood bootstrap is NOT
 * ready yet: it BLOCKS entry, shows a two-step progress strip fed by REAL sync
 * rows, and the parent auto-advances (proceeds to the recap) the moment the
 * flow becomes ready.
 *
 * Honesty rule (from EntryGithubUrlForm): the strip settles every checkmark from
 * the real `hiveFromRepo.progress` rows — never a fabricated tick or a fake
 * timeout that opens the gate while the clone is genuinely still running.
 *
 * Robust to the empty/degraded case: outside a SyncProvider (or before the
 * trigger lands any rows) `hasRows` is false; rather than hard-block forever we
 * surface a soft "still preparing…" with the Retry, so the user is never trapped.
 */

import { useEffect, useRef, useState } from 'react';
import {
  useDogfoodBootstrapProgress,
  startDogfoodBootstrap,
  type BootstrapStep,
  type BootstrapStatus,
  type DogfoodBootstrapProgress,
} from '../useDogfoodBootstrapProgress';

const STRIP_LABELS: Record<BootstrapStep, string> = {
  clone: 'Downloading Papercusp workspace',
  submodules: 'Fetching submodules',
};

const STRIP_ORDER: readonly BootstrapStep[] = ['clone', 'submodules'] as const;

/** Per-step display status, derived from the latest row for that step. */
function stepStatus(p: DogfoodBootstrapProgress, step: BootstrapStep): BootstrapStatus | 'pending' {
  const row = step === 'clone' ? p.clone : p.submodules;
  return row?.status ?? 'pending';
}

function StepRow({
  label,
  status,
  percent,
  detail,
}: {
  label: string;
  status: BootstrapStatus | 'pending';
  percent?: number;
  detail?: string;
}) {
  const dim = status === 'pending' || status === 'skipped';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', opacity: dim ? 0.5 : 1 }}>
      <span style={{ width: 16, minWidth: 16, textAlign: 'center', fontSize: 13, lineHeight: 1 }}>
        {status === 'done' && <span style={{ color: 'var(--success, #22c55e)', fontWeight: 700 }}>✓</span>}
        {status === 'error' && <span style={{ color: 'var(--bad, #ef4444)', fontWeight: 700 }}>✕</span>}
        {status === 'skipped' && <span style={{ color: 'var(--fg-dim, #888)' }}>—</span>}
        {status === 'pending' && <span style={{ color: 'var(--fg-dim, #888)' }}>○</span>}
        {status === 'running' && (
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              border: '2px solid var(--accent, #6366f1)',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'pc-dogfood-gate-spin 0.7s linear infinite',
            }}
          />
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: status === 'running' ? 600 : 400 }}>
          {label}
          {status === 'skipped' && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fg-mute)' }}>skipped</span>}
          {detail && status === 'running' && (
            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fg-mute)' }}>{detail}</span>
          )}
          {percent != null && status === 'running' && (
            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fg-mute)' }}>{percent}%</span>
          )}
        </span>
        {percent != null && status === 'running' && (
          <span
            aria-hidden="true"
            style={{ display: 'block', marginTop: 4, height: 3, borderRadius: 2, background: 'var(--border, #2a2d36)', overflow: 'hidden' }}
          >
            <span
              style={{ display: 'block', height: '100%', width: `${percent}%`, background: 'var(--accent, #6366f1)', borderRadius: 2, transition: 'width 240ms ease' }}
            />
          </span>
        )}
      </span>
    </div>
  );
}

export interface BootstrapFinishGateProps {
  /** Fired exactly once when the flow first becomes ready — the parent proceeds. */
  onReady: () => void;
  /** Back out of the gate without finishing (return to the wizard). */
  onCancel: () => void;
}

/** Bounded auto-retry of a transient bootstrap error before any terminal
 *  "failed" is shown (EI-3548). Backoff per attempt index (2s, 4s, 8s). */
const MAX_AUTO_RETRIES = 3;
const AUTO_BACKOFF_MS = [2000, 4000, 8000] as const;

export function BootstrapFinishGate({ onReady, onCancel }: BootstrapFinishGateProps) {
  const p = useDogfoodBootstrapProgress();
  const [retrying, setRetrying] = useState(false);
  // Fire-once trigger if we land here with no rows at all (e.g. the boot trigger
  // no-op'd before gh was signed in, or the user reached Finish before StepGit's
  // success path fired). Idempotent + single-flight server-side, so this is safe.
  const triggeredRef = useRef(false);
  // Auto-advance latch — onReady must fire exactly once.
  const advancedRef = useRef(false);
  // How many automatic retries we've fired for the current error episode.
  const [autoAttempts, setAutoAttempts] = useState(0);
  const autoExhausted = autoAttempts >= MAX_AUTO_RETRIES;
  // Still self-healing: an error is showing but we haven't given up yet. A
  // git-missing error is a USER-ACTION error (install git), not transient — never
  // auto-retry it; surface the install hint + a manual Retry immediately.
  const autoRetrying = p.hasError && !autoExhausted && !p.gitMissing;

  useEffect(() => {
    if (p.ready && !advancedRef.current) {
      advancedRef.current = true;
      onReady();
    }
  }, [p.ready, onReady]);

  useEffect(() => {
    // No rows yet and we haven't kicked it → kick the clone so rows start to flow.
    // (If rows already exist the boot/StepGit trigger has it covered.)
    if (!p.hasRows && !triggeredRef.current && !p.ready) {
      triggeredRef.current = true;
      void startDogfoodBootstrap();
    }
  }, [p.hasRows, p.ready]);

  // EI-3548: auto-retry a transient error with backoff before surfacing a
  // terminal failure — a brief GitHub-connect blip self-heals without the user
  // ever seeing a scary "failed" or having to click Retry. Bounded by
  // MAX_AUTO_RETRIES; a manual Retry resets the counter.
  useEffect(() => {
    if (!p.hasError || retrying || autoExhausted || p.gitMissing) return;
    const delay = AUTO_BACKOFF_MS[Math.min(autoAttempts, AUTO_BACKOFF_MS.length - 1)];
    const t = setTimeout(() => {
      setAutoAttempts((a) => a + 1);
      void startDogfoodBootstrap();
    }, delay);
    return () => clearTimeout(t);
  }, [p.hasError, retrying, autoExhausted, autoAttempts]);

  const retry = async () => {
    setRetrying(true);
    triggeredRef.current = true;
    setAutoAttempts(0); // manual retry → re-arm auto-retry for a fresh episode
    try {
      await startDogfoodBootstrap();
    } finally {
      setRetrying(false);
    }
  };

  // Headline percent — the active (running) step's measure, when present.
  const pct = p.activePercent;

  return (
    <div className="pc-setup-wizard pc-setup-wizard--recap pc-setup-wizard--friendly" data-mode="first-run">
      <div className="pc-step pc-step--recap pc-setup-recap-card" data-testid="bootstrap-finish-gate">
        <style>{`@keyframes pc-dogfood-gate-spin { to { transform: rotate(360deg); } }`}</style>
        <div className="pc-setup-recap-copy">
          <p className="pc-setup-recap-kicker">
            {!p.hasError ? 'Almost there' : autoRetrying ? 'Reconnecting…' : 'Setup needs attention'}
          </p>
          <h2 className="pc-step__lead">
            {!p.hasError
              ? pct != null
                ? `Finishing setup — Papercusp workspace is still downloading (${pct}%)`
                : 'Finishing setup — Papercusp workspace is still downloading'
              : p.gitMissing
                ? 'Git isn’t available on this machine'
                : autoRetrying
                  ? p.networkError
                    ? 'Couldn’t reach GitHub — retrying…'
                    : 'Setup hit a snag — retrying…'
                  : p.networkError
                    ? 'Couldn’t reach GitHub'
                    : 'Workspace download failed'}
          </h2>
          <p className="pc-step__lead">
            {!p.hasError
              ? 'The Papercusp workspace is being fetched in the background. We’ll take you into the app the moment it’s ready.'
              : p.gitMissing
                ? 'Papercusp needs git to download the workspace. On macOS, install it with “xcode-select --install” (or “brew install git”); on Linux use your package manager. Then Retry.'
                : autoRetrying
                  ? `Retrying automatically (attempt ${autoAttempts + 1} of ${MAX_AUTO_RETRIES})…`
                  : p.networkError
                    ? "We couldn’t reach GitHub after several tries. This is a network/connectivity problem — not your GitHub sign-in, which is fine. Check your connection, then retry."
                    : "We couldn’t finish cloning the Papercusp workspace. Retry below — it picks up where it left off."}
          </p>
        </div>

        <div
          style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', margin: '6px 0 4px', textAlign: 'left' }}
        >
          {STRIP_ORDER.map((step) => {
            const status = stepStatus(p, step);
            const row = step === 'clone' ? p.clone : p.submodules;
            return (
              <StepRow
                key={step}
                label={STRIP_LABELS[step]}
                status={status}
                {...(row?.percent != null ? { percent: row.percent } : {})}
                {...(row?.detail ? { detail: row.detail } : {})}
              />
            );
          })}
        </div>

        {!p.hasRows && !p.hasError && (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--fg-mute)' }} data-testid="bootstrap-gate-preparing">
            Still preparing… if this doesn’t start shortly, retry below.
          </p>
        )}

        <div className="pc-step__actions" style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
          {/* While auto-retrying we self-heal silently — the manual Retry only
              appears once automatic attempts are exhausted, immediately for a
              user-action error (git missing), or when there are no rows at all. */}
          {((p.hasError && (autoExhausted || p.gitMissing)) || !p.hasRows) && (
            <button
              type="button"
              className="pc-btn pc-btn--primary"
              data-testid="bootstrap-gate-retry"
              onClick={() => void retry()}
              disabled={retrying}
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          )}
          <button type="button" className="pc-btn" onClick={onCancel}>
            Back to setup
          </button>
        </div>
      </div>
    </div>
  );
}

export default BootstrapFinishGate;
