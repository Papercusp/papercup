/**
 * EnvSwitcherBar — the cross-platform, in-webview env top bar
 * (dogfood-silent-canonical-hive-join P-013 / P-014 / P-017, D-006/D-008).
 *
 * The dev box's env switcher is a Linux-only native GTK bar (papercusp-desktop
 * src-tauri/src/dev_wrapper.rs) that navigates the webview between the prod/staging/
 * dev/local operators on fixed local ports. This is its DATA-DRIVEN, cross-platform
 * twin: a slim fixed top bar that renders the same envs (fed by GET
 * /api/desktop/dev-operators, which probes reachability SERVER-side because a webview
 * can't cross-origin probe sibling operators — CORS), and switches by a top-level
 * window.location navigation (not CORS-bound). It ships in PUBLIC builds (P-013) —
 * unlike the dev-only GTK bar — but SELF-HIDES unless ≥2 envs are actually reachable,
 * so a single-operator install shows nothing until install-time provisioning (P-017)
 * brings the other envs up.
 *
 * Buttons: the four envs (dev/prod/staging/local) PLUS a "release" button (D-008) that
 * switches to the UNCHANGED code from the release PACKAGE — the immutable bundled
 * operator that can't be broken by local edits (the always-good escape hatch). There is
 * NO remote-main git-reset button (D-008 dropped it; the P-015 endpoint stays backend-
 * only).
 *
 * Styling mirrors DogfoodBootstrapBanner (opaque --bg-1 bar, fixed top, overlays —
 * routes scroll underneath, no layout reservation).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface ResolvedDevOperator {
  id: string;
  label: string;
  port: number;
  tooltip: string;
  origin: string;
  reachable: boolean;
  sha: string | null;
  isSelf: boolean;
  kind: 'env' | 'release';
  enabled: boolean;
}

interface DevOperatorsResponse {
  ok: boolean;
  operators: ResolvedDevOperator[];
  selfPort: number | null;
}

// Matches the native bar's status cadence (dev_wrapper.rs POLL_INTERVAL / VersionBadge).
const REFRESH_MS = 30_000;

export function EnvSwitcherBar() {
  const [data, setData] = useState<DevOperatorsResponse | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/desktop/dev-operators', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!r.ok) return;
      const j = (await r.json()) as DevOperatorsResponse;
      if (mounted.current && j?.ok) setData(j);
    } catch {
      /* not desktop / endpoint absent → the bar simply stays hidden */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const navigate = useCallback((op: ResolvedDevOperator) => {
    if (op.isSelf || !op.reachable) return;
    // Carry the current SPA route + query across the env switch (matches the native
    // bar's switch_to). A top-level navigation is not CORS-bound.
    const target = op.origin + window.location.pathname + window.location.search + window.location.hash;
    window.location.assign(target);
  }, []);

  // Right-click an env to enable/disable whether it's provisioned/started (D-007).
  // Persisted server-side + agent-legible (POST /api/desktop/dev-operators/set-enabled).
  // 'release' is the immutable escape hatch — never disablable.
  const toggleEnabled = useCallback(
    async (op: ResolvedDevOperator) => {
      if (op.kind === 'release') return;
      try {
        await fetch('/api/desktop/dev-operators/set-enabled', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: op.id, enabled: !op.enabled }),
          credentials: 'same-origin',
        });
      } catch {
        /* best-effort */
      }
      void load();
    },
    [load],
  );

  const operators = data?.operators ?? [];
  const envOps = operators.filter((o) => o.kind === 'env');
  const releaseOp = operators.find((o) => o.kind === 'release');
  // Self-regulating visibility: show only when there's a REAL choice (≥2 reachable
  // ENV operators). Single-operator installs (pre-P-017) render nothing.
  if (envOps.filter((o) => o.reachable).length < 2) return null;

  const currentPort =
    typeof window !== 'undefined' && window.location.port ? Number(window.location.port) : NaN;

  const renderButton = (op: ResolvedDevOperator, release = false) => {
    const active = op.isSelf || (Number.isFinite(currentPort) && op.port === currentPort);
    const off = !op.enabled; // user-disabled (D-007) — won't be provisioned/started
    const inert = !op.reachable && !active; // not running → can't navigate
    const label = op.reachable ? op.tooltip : `${op.tooltip} (not running)`;
    return (
      <button
        key={op.id}
        type="button"
        data-testid={`env-btn-${op.id}`}
        data-active={active ? 'true' : 'false'}
        data-reachable={op.reachable ? 'true' : 'false'}
        data-enabled={op.enabled ? 'true' : 'false'}
        aria-current={active ? 'true' : undefined}
        aria-disabled={inert ? 'true' : undefined}
        aria-label={
          off
            ? `${label} — disabled; right-click to enable`
            : release
              ? label
              : `${label}; right-click to disable`
        }
        onClick={() => navigate(op)}
        // Right-click toggles enable/disable (no HTML `disabled`, so the context menu
        // still fires on a not-running env). Release can't be disabled.
        onContextMenu={
          release
            ? undefined
            : (e) => {
                e.preventDefault();
                void toggleEnabled(op);
              }
        }
        style={{
          ...(release ? { marginLeft: 'auto' } : {}),
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 5,
          cursor: op.reachable && !active ? 'pointer' : 'default',
          border: `1px solid ${
            active
              ? 'var(--accent, #6366f1)'
              : release
                ? 'var(--good, #22c55e)'
                : 'var(--border, #2a2d36)'
          }`,
          background: active ? 'var(--accent, #6366f1)' : 'transparent',
          color: active
            ? '#fff'
            : op.reachable
              ? release
                ? 'var(--good, #22c55e)'
                : 'var(--fg, #e8e8e8)'
              : 'var(--fg-mute, #888)',
          textDecoration: off ? 'line-through' : undefined,
          opacity: off ? 0.4 : op.reachable || active ? 1 : 0.45,
          font: 'inherit',
        }}
      >
        {release ? '↩ release' : op.label}
        {!release && <span style={{ fontSize: 10, opacity: 0.7 }}>:{op.port}</span>}
      </button>
    );
  };

  return (
    <nav
      data-testid="env-switcher-bar"
      aria-label="Environment switcher"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        // Just under DogfoodBootstrapBanner (…645) so a transient setup banner
        // overlays this persistent bar when both are present.
        zIndex: 2147483640,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--fg, #e8e8e8)',
        background: 'var(--bg-1, #0b1220)',
        borderBottom: '1px solid var(--border, #2a2d36)',
        boxShadow: '0 1px 6px rgba(0,0,0,0.35)',
      }}
    >
      <span
        title="Click an env to switch; right-click to enable/disable it"
        style={{ color: 'var(--fg-mute, #888)', textTransform: 'uppercase', fontSize: 10, cursor: 'help' }}
      >
        env
      </span>
      {envOps.map((op) => renderButton(op))}
      {releaseOp && renderButton(releaseOp, true)}
    </nav>
  );
}

export default EnvSwitcherBar;
