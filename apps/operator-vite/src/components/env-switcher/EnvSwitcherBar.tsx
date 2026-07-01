/**
 * EnvSwitcherBar — the cross-platform, in-webview env top bar. The SINGLE env
 * bar on every platform (the Linux-only native GTK dev-wrapper bar and the
 * chrome-webview experiment were both removed — see papercusp-desktop
 * src-tauri/src/env_switch.rs).
 *
 * Durability (the whole point of this rewrite): the env list comes from the
 * desktop's `list_envs` Tauri command — the AUTHORITATIVE source that probes the
 * sibling operators in Rust and can't be misrouted. The bar reads THAT, not the
 * `/api/desktop/dev-operators` HTTP fetch, so a misrouted `/api` (Trap 5) or a
 * bad target build can NEVER make it self-hide. The HTTP fetch is kept ONLY for
 * enrichment (the deployed sha, the immutable "release" escape-hatch button, and
 * the per-env enabled state) and the git-pipeline status — all best-effort, none
 * able to hide the bar. If a target build white-screens so even this in-webview
 * bar can't paint, the native menu backstop (Env → CmdOrCtrl+Shift+1..4, in
 * env_switch.rs) still switches you out.
 *
 * Switching is a top-level `window.location` navigation (not CORS-bound); `/api`
 * follows automatically because the desktop's on_page_load retargets it to
 * whatever env the webview lands on (env_switch::retarget_for_url) — no Tauri
 * call needed on the switch.
 *
 * Styling mirrors DogfoodBootstrapBanner (opaque --bg-1 bar, fixed top, overlays —
 * routes scroll underneath, with a #root padding reservation so it never covers
 * the app's sticky header).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

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

/** The desktop `list_envs` command's shape (env_switch.rs `EnvInfo`, camelCase). */
interface TauriEnv {
  id: string;
  label: string;
  port: number;
  origin: string;
  tooltip: string;
  reachable: boolean;
  isSelf: boolean;
}

/** A `deploy.*` commit ref (git-pipeline-stats.ts `CommitRef`). */
interface CommitRef {
  sha?: string | null;
  committedAtMs?: number | null;
}

/** The subset of GET /api/desktop/git-pipeline this bar renders — the SAME pipeline stats
 *  the native dev-wrapper bar showed: the staging (mainHead) / green-pin (ready) / deployed
 *  SHAs + tip age, behind-count, and the green-checkpoint gate health WITH time-since-last-green
 *  / red-streak / wedged-ticker. Shapes from git-pipeline-stats.ts. */
interface PipelineStats {
  deploy?: {
    mainHead?: CommitRef | null; // the integration branch == "staging" (field name predates the rename)
    ready?: CommitRef | null; // the green pin == the `main` release branch
    deployed?: CommitRef | null; // what the :3070 release checkout runs
    deployedBehindReady?: number | null; // green & deployable but not yet deployed
    readyBehindMain?: number | null; // staging buffer: main tip not yet green-checkpointed
  } | null;
  gate?: {
    stalled?: boolean;
    consecutiveReds?: number | null;
    lastGreenAtMs?: number | null; // time the gate last went green (the user's "time since last green")
    fireStale?: boolean; // the green-checkpoint ticker is wedged / non-firing (WI-282)
  } | null;
}

const sha7 = (s: string | null | undefined): string => (typeof s === 'string' && s ? s.slice(0, 7) : '—');

/** Compact "23s / 14m / 3h / 2d" age from an epoch-ms timestamp (— when absent). */
function ago(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

const REFRESH_MS = 30_000;

export function EnvSwitcherBar() {
  // `null` until the first resolve, so we can tell "not desktop" (stays null)
  // from "desktop, no envs" ([]). The Tauri list is the never-hide floor.
  const [tauriEnvs, setTauriEnvs] = useState<TauriEnv[] | null>(null);
  const [data, setData] = useState<DevOperatorsResponse | null>(null);
  const [pipeline, setPipeline] = useState<PipelineStats | null>(null);
  const mounted = useRef(true);
  const navRef = useRef<HTMLElement | null>(null);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    // AUTHORITATIVE env list from the desktop (probed in Rust; never 404s).
    // Detached so a slow/throwing invoke off-desktop can't block the HTTP path
    // below (which is what the bar falls back to in a plain browser / tests).
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const envs = await invoke<TauriEnv[]>('list_envs');
        if (mounted.current) setTauriEnvs(Array.isArray(envs) ? envs : []);
      } catch {
        /* not desktop / command absent → the HTTP list (if any) carries the bar */
      }
    })();
    // ENRICHMENT only (never able to hide the bar): server-side reachability, the
    // deployed sha, the immutable "release" escape-hatch button, the enabled state.
    try {
      const r = await fetch('/api/desktop/dev-operators', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (r.ok) {
        const j = (await r.json()) as DevOperatorsResponse;
        if (mounted.current && j?.ok) setData(j);
      }
    } catch {
      /* endpoint absent / misrouted → the Tauri floor still renders the bar */
    }
    // Pipeline stats (best-effort; the bar renders without them).
    try {
      const pr = await fetch('/api/desktop/git-pipeline', { credentials: 'same-origin', cache: 'no-store' });
      if (pr.ok && mounted.current) setPipeline((await pr.json()) as PipelineStats);
    } catch {
      /* stats are decorative — never block the bar */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const navigate = useCallback((op: ResolvedDevOperator) => {
    if (op.isSelf || !op.reachable) return;
    // Carry the current SPA route + query across the env switch. A top-level
    // navigation is not CORS-bound; the desktop's on_page_load retargets /api.
    const target = op.origin + window.location.pathname + window.location.search + window.location.hash;
    window.location.assign(target);
  }, []);

  // Right-click an env to enable/disable whether it's provisioned/started (D-007).
  // Persisted server-side (POST /api/desktop/dev-operators/set-enabled).
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

  // Merge: the Tauri env list is the FLOOR (authoritative core fields, never-hide);
  // the HTTP list ENRICHES it (sha + enabled) and ADDS HTTP-only ops (the release
  // button). HTTP can never remove a Tauri env, so a /api glitch can't hide the bar.
  const httpOps = data?.operators ?? [];
  const merged = new Map<string, ResolvedDevOperator>();
  for (const e of tauriEnvs ?? []) {
    merged.set(e.id, {
      id: e.id,
      label: e.label,
      port: e.port,
      tooltip: e.tooltip,
      origin: e.origin,
      reachable: e.reachable,
      sha: null,
      isSelf: e.isSelf,
      kind: 'env',
      enabled: true,
    });
  }
  for (const op of httpOps) {
    const existing = merged.get(op.id);
    if (existing) {
      // Enrich only — keep the Tauri floor's authoritative reachable/isSelf/origin.
      merged.set(op.id, { ...existing, sha: op.sha, enabled: op.enabled });
    } else {
      merged.set(op.id, op); // HTTP-only (the immutable release escape hatch)
    }
  }
  const operators = [...merged.values()];
  const envOps = operators.filter((o) => o.kind === 'env');
  const releaseOp = operators.find((o) => o.kind === 'release');

  // Show whenever we have ANY env to switch to. On the dev desktop the Tauri
  // floor (list_envs) always supplies the four envs, so the bar NEVER self-hides
  // there — even if /api is misrouted (Trap 5) or the HTTP enrichment 404s. Off
  // the dev desktop (plain browser / a build without the endpoint) there are no
  // envs from either source, so it stays hidden where the feature doesn't apply.
  const barVisible = envOps.length > 0;

  // Reserve layout space so this FIXED bar never overlays app chrome. Two moves,
  // because #root padding alone is NOT enough:
  //   1. Pad #root by the bar height → pushes IN-FLOW content (the <main> column)
  //      down so it starts below the bar.
  //   2. Publish the height as `--pc-env-bar-h` on <html> → the app's top-anchored
  //      chrome that is FIXED/STICKY to the viewport (the sticky .pc-header, which
  //      otherwise slides UNDER the bar on scroll; the fixed .pclsb / .pcdar side
  //      rails, whose tops sit behind the bar) offsets itself via
  //      `top: var(--pc-env-bar-h)` (see globals.css). #root padding can't move
  //      those — they anchor to the viewport, not #root.
  // Both clear on hide. A ResizeObserver re-measures if the bar wraps.
  useLayoutEffect(() => {
    const root = document.getElementById('root');
    const docEl = document.documentElement;
    if (!barVisible) {
      root?.style.removeProperty('padding-top');
      docEl.style.removeProperty('--pc-env-bar-h');
      return;
    }
    const el = navRef.current;
    if (!el) return;
    const apply = () => {
      const h = `${el.offsetHeight}px`;
      if (root) root.style.paddingTop = h;
      docEl.style.setProperty('--pc-env-bar-h', h);
    };
    apply();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
    ro?.observe(el);
    window.addEventListener('resize', apply);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', apply);
      root?.style.removeProperty('padding-top');
      docEl.style.removeProperty('--pc-env-bar-h');
    };
  }, [barVisible]);

  if (!barVisible) return null;

  const currentPort =
    typeof window !== 'undefined' && window.location.port ? Number(window.location.port) : NaN;

  // Platform label for the invisible global env-switch shortcuts
  // (env_switch::register_backstop_shortcuts registers CmdOrCtrl+Alt+N).
  const MOD =
    typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) ? '⌘⌥' : 'Ctrl+Alt+';
  // The shortcut number for an env = its 1-based position in the Tauri floor
  // (list_envs order == the Rust registration order), so the badge can't drift
  // from what's actually bound. null off-desktop (no shortcuts there → no badge).
  const shortcutFor = (op: ResolvedDevOperator): number | null => {
    const i = (tauriEnvs ?? []).findIndex((e) => e.port === op.port);
    return i >= 0 ? i + 1 : null;
  };

  const renderButton = (op: ResolvedDevOperator, release = false, shortcutNum: number | null = null) => {
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
        {shortcutNum != null && (
          <span
            aria-hidden="true"
            title={`${MOD}${shortcutNum} — switches here even if this bar is hidden`}
            style={{
              fontSize: 9,
              lineHeight: 1,
              marginLeft: 3,
              padding: '1px 3px',
              borderRadius: 3,
              border: '1px solid currentColor',
              opacity: 0.5,
              fontWeight: 700,
            }}
          >
            {shortcutNum}
          </span>
        )}
      </button>
    );
  };

  return (
    <nav
      ref={navRef}
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
      {tauriEnvs != null && envOps.length > 0 && (
        <span
          title="Global keyboard shortcuts — switch env even when this bar is hidden or a build white-screens"
          style={{ color: 'var(--fg-mute, #888)', fontSize: 9.5, opacity: 0.85, whiteSpace: 'nowrap' }}
        >
          {MOD}1–{envOps.length}
        </span>
      )}
      {envOps.map((op) => renderButton(op, false, shortcutFor(op)))}
      {pipeline?.deploy && (
        <span
          data-testid="env-pipeline-stats"
          title="git pipeline — staging (integration tip + age) / green (release pin) / deployed (:3070) SHAs · green-checkpoint gate: time since last green, red streak, wedged-ticker"
          style={{
            marginLeft: 14,
            fontSize: 10,
            fontWeight: 400,
            whiteSpace: 'nowrap',
            color: 'var(--fg-mute, #888)',
          }}
        >
          staging {sha7(pipeline.deploy.mainHead?.sha)}·{ago(pipeline.deploy.mainHead?.committedAtMs)} · green{' '}
          {sha7(pipeline.deploy.ready?.sha)} · deployed {sha7(pipeline.deploy.deployed?.sha)}
          {typeof pipeline.deploy.deployedBehindReady === 'number' && pipeline.deploy.deployedBehindReady > 0
            ? ` (↓${pipeline.deploy.deployedBehindReady})`
            : ''}
          {pipeline.gate && (
            <>
              <span
                style={{
                  marginLeft: 6,
                  color:
                    pipeline.gate.stalled || pipeline.gate.fireStale
                      ? 'var(--bad, #ef4444)'
                      : 'var(--good, #22c55e)',
                }}
              >
                {pipeline.gate.stalled || pipeline.gate.fireStale ? '⚠ gate' : '✓ gate'}
              </span>
              <span style={{ marginLeft: 4 }}>
                {' · last green '}
                {ago(pipeline.gate.lastGreenAtMs)} ago
                {(pipeline.gate.consecutiveReds ?? 0) > 0 ? ` · ${pipeline.gate.consecutiveReds} red` : ''}
                {pipeline.gate.fireStale ? ' · ticker wedged' : ''}
              </span>
            </>
          )}
        </span>
      )}
      {releaseOp && renderButton(releaseOp, true)}
    </nav>
  );
}

export default EnvSwitcherBar;
