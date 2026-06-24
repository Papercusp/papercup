'use client';

/**
 * DogfoodBootstrapBanner — the slim, NON-blocking top bar shown WHENEVER the
 * "Papercusp dogfood hive clone-on-first-boot" is in progress (clone-on-first-
 * boot stage 2 / desktop UI, part A). Mounted once at the router root
 * (__root.tsx) inside RootSyncProvider so it overlays EVERY route and the rest
 * of the app / setup stays fully usable beneath it.
 *
 * Visibility is settled from REAL sync rows (the honesty rule from
 * EntryGithubUrlForm — never fabricate a checkmark):
 *   - appears once `hiveFromRepo.progress` rows for BOOTSTRAP_PROGRESS_ID exist
 *     AND the flow is in progress (not all-terminal, no error → see
 *     reduceBootstrapRows.inProgress);
 *   - auto-HIDES the moment the flow is ready (submodules done/skipped) or when
 *     there are simply no rows (off desktop / not triggered).
 *
 * An ERROR also surfaces here (red bar) so a wedged clone is visible app-wide;
 * the actionable Retry lives in the setup-finish gate (this bar is informational
 * only, to keep the chrome non-interactive and out of the way).
 */

import {
  useDogfoodBootstrapProgress,
  bootstrapStepLabel,
} from './useDogfoodBootstrapProgress';

export function DogfoodBootstrapBanner() {
  const p = useDogfoodBootstrapProgress();

  // Show only while genuinely in progress, or on a hard error. Ready / no rows →
  // hidden (auto-hide). This keeps the chrome clear once the workspace lands.
  if (!p.hasRows) return null;
  if (!p.inProgress && !p.hasError) return null;

  const label = bootstrapStepLabel(p.activeStep);
  const pct = p.activePercent;
  const detail = p.activeDetail;
  const isError = p.hasError;
  // The bootstrap parks the clone at 0% `running` with a "Sign in to GitHub…"
  // detail when auth isn't ready yet (bootstrap-papercusp-hive AWAITING_GH_SIGNIN_DETAIL).
  // Surface that prompt as the headline (and keep the 0% bar visible) instead of
  // the generic "Downloading…" label.
  const awaitingAuth = !isError && !!detail && /sign in to github/i.test(detail);

  return (
    <div
      data-testid="dogfood-bootstrap-banner"
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 2147483645, // just under the sonner Toaster (…646)
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '5px 14px',
        fontSize: 12,
        fontWeight: 500,
        color: isError ? 'var(--bad, #ef4444)' : 'var(--fg, #e8e8e8)',
        background: isError ? 'var(--bad-bg, rgba(239,68,68,0.10))' : 'var(--bg-2, #14161c)',
        borderBottom: `1px solid ${isError ? 'var(--bad, #ef4444)' : 'var(--border, #2a2d36)'}`,
        boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
        // Non-blocking: the bar never traps pointer/scroll for the rest of the app.
        // It is fixed at the very top; routes scroll underneath.
      }}
    >
      <style>{`@keyframes pc-dogfood-spin { to { transform: rotate(360deg); } }`}</style>
      {isError ? (
        <span aria-hidden="true" style={{ fontWeight: 700 }}>✕</span>
      ) : (
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 12,
            height: 12,
            minWidth: 12,
            border: '2px solid var(--accent, #6366f1)',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'pc-dogfood-spin 0.7s linear infinite',
          }}
        />
      )}
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {isError ? (
          <>Setting up Papercusp workspace failed — finish setup to retry.</>
        ) : awaitingAuth ? (
          <>Setting up Papercusp workspace — <strong>{detail}</strong></>
        ) : (
          <>
            Setting up Papercusp workspace — {label}
            {detail ? <span style={{ color: 'var(--fg-mute, #888)' }}> ({detail})</span> : null}
            {pct != null ? <> {pct}%</> : null}
          </>
        )}
      </span>
      {/* Thin progress bar fed by the measured percent (when present). */}
      {!isError && pct != null && (
        <span
          aria-hidden="true"
          style={{
            position: 'relative',
            flex: 1,
            height: 3,
            minWidth: 40,
            maxWidth: 240,
            borderRadius: 2,
            background: 'var(--border, #2a2d36)',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              position: 'absolute',
              inset: 0,
              width: `${pct}%`,
              background: 'var(--accent, #6366f1)',
              borderRadius: 2,
              transition: 'width 240ms ease',
            }}
          />
        </span>
      )}
    </div>
  );
}

export default DogfoodBootstrapBanner;
