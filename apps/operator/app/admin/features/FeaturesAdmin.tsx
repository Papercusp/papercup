'use client';

import { useCallback, useEffect, useState } from 'react';
import { createResilientEventSource } from '@restart/sse';
import { ALL_FLAG_KEYS, FLAGS, type FlagKey, type FlagValues } from '@papercusp/flags';

/**
 * Interactive feature-flag console. Lets admins:
 *   - Apply preset modes ("V1 Production" / "Full testing") in one click
 *   - Toggle `testingFeatures` (master switch — operator phones home or not)
 *   - Flip individual flags in PostHog when in testing mode
 *
 * Source of truth:
 *   - testingFeatures lives in ~/.papercusp/posthog.json
 *   - individual flag values live in PostHog at flags.papercuspai.com
 * Both are fetched live via the operator's flag-bus.
 */

const FLAG_LABELS: Record<FlagKey, string> = {
  [FLAGS.SNAPSHOTS]: 'Snapshots',
  [FLAGS.TEMPLATES]: 'Templates',
  [FLAGS.MARKETPLACE]: 'Marketplace',
  [FLAGS.CLOUDFLARE_PUBLISH]: 'Cloudflare publishing',
  [FLAGS.ORACLE]: 'Oracle (tutorial)',
  [FLAGS.RUST_PORT_UI]: 'Rust-port surfaces (dev)',
  [FLAGS.HARNESS_PHASES]: 'Harness phases',
  [FLAGS.DESIGN]: 'Design tab',

};

const FLAG_BLURBS: Record<FlagKey, string> = {
  [FLAGS.SNAPSHOTS]: 'Save / restore mission state. Cut for V1 ship.',
  [FLAGS.TEMPLATES]: 'Save / install harness templates. Cut for V1 ship.',
  [FLAGS.MARKETPLACE]: 'Plugin + snapshot + template marketplace. Cut for V1 ship.',
  [FLAGS.CLOUDFLARE_PUBLISH]: 'Publish-to-Cloudflare flow. Cut for V1 ship.',
  [FLAGS.ORACLE]: 'Always-on tutorial dock + Oracle endpoint. Cut for V1 ship.',
  [FLAGS.RUST_PORT_UI]: 'Reserved for Tauri build-time gating (no operator UI surface yet).',
  [FLAGS.HARNESS_PHASES]: 'Multi-phase harness (staging / testing / production). Cut for V1 ship.',
  [FLAGS.DESIGN]: 'In-harness design tab + /design route. Cut for V1 ship.',

};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; testingFeatures: boolean; source: string; flags: FlagValues };

export default function FeaturesAdmin() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [statusRes, flagsRes] = await Promise.all([
        fetch('/api/flags/testing-features', { cache: 'no-store' }),
        fetch('/api/flags/bootstrap', { cache: 'no-store' }),
      ]);
      if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status} on /api/flags/testing-features`);
      if (!flagsRes.ok) throw new Error(`HTTP ${flagsRes.status} on /api/flags/bootstrap`);
      const status = (await statusRes.json()) as { testingFeatures: boolean; source: string };
      const flagsPayload = (await flagsRes.json()) as { flags: FlagValues };
      setState({
        kind: 'ok',
        testingFeatures: status.testingFeatures,
        source: status.source,
        flags: flagsPayload.flags,
      });
    } catch (e) {
      setState({ kind: 'error', message: String((e as Error)?.message ?? e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Subscribe to the flag-bus SSE so this page reflects live flag flips
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = createResilientEventSource({
      url: '/api/flags/stream',
      withCredentials: true,
      handlers: {
        flag_changed: () => void refresh(),
        flags_payload: () => void refresh(),
      },
    });
    return () => source.close();
  }, [refresh]);

  async function applyPreset(name: 'production' | 'testing') {
    setBusy(`preset:${name}`);
    try {
      const res = await fetch('/api/flags/preset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setToast(name === 'production' ? 'Switched to V1 Production' : 'Switched to Full testing');
      await refresh();
    } catch (e) {
      setToast(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 3000);
    }
  }

  async function toggleTesting(next: boolean) {
    setBusy('testing-features');
    try {
      const res = await fetch('/api/flags/testing-features', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setToast(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 3000);
    }
  }

  async function toggleFlag(key: FlagKey, next: boolean) {
    setBusy(`flag:${key}`);
    try {
      const res = await fetch('/api/flags/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, enabled: next }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setToast(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 3000);
    }
  }

  if (state.kind === 'loading') {
    return <div className="fa-shell"><div className="fa-spinner">Loading…</div></div>;
  }
  if (state.kind === 'error') {
    return <div className="fa-shell"><div className="fa-error">Failed to load: {state.message}</div></div>;
  }

  const testingOn = state.testingFeatures;
  const effective = state.flags;

  return (
    <div className="fa-shell">
      {/* Preset row */}
      <section className="fa-section">
        <h2 className="fa-h2">Preset</h2>
        <p className="fa-p">
          One-click swap between V1 ship state and the full testing build.
        </p>
        <div className="fa-presets">
          <button
            type="button"
            className={`fa-preset${!testingOn ? ' active' : ''}`}
            disabled={busy !== null}
            onClick={() => applyPreset('production')}
          >
            <span className="fa-preset-emoji">🚀</span>
            <span className="fa-preset-title">V1 Production</span>
            <span className="fa-preset-blurb">
              testingFeatures = false · bundled defaults serve everything · zero PostHog contact
            </span>
            {busy === 'preset:production' && <span className="fa-preset-busy">…</span>}
          </button>
          <button
            type="button"
            className={`fa-preset${testingOn ? ' active' : ''}`}
            disabled={busy !== null}
            onClick={() => applyPreset('testing')}
          >
            <span className="fa-preset-emoji">🧪</span>
            <span className="fa-preset-title">Full testing</span>
            <span className="fa-preset-blurb">
              testingFeatures = true · all flags flipped on in PostHog
            </span>
            {busy === 'preset:testing' && <span className="fa-preset-busy">…</span>}
          </button>
        </div>
      </section>

      {/* Master switch */}
      <section className="fa-section">
        <h2 className="fa-h2">Master switch</h2>
        <div className="fa-master">
          <div className="fa-master-text">
            <strong>testingFeatures</strong>{' '}
            <span className={`fa-pill ${testingOn ? 'on' : 'off'}`}>
              {testingOn ? 'on' : 'off'}
            </span>
            <div className="fa-master-blurb">
              {testingOn
                ? 'Operator is phoning home to flags.papercuspai.com. Per-flag toggles below are live.'
                : 'Operator is using bundled defaults (all flags off). PostHog is not being contacted.'}
              <br />
              <span className="fa-source">Config source: {state.source}</span>
            </div>
          </div>
          <button
            type="button"
            className={`fa-toggle${testingOn ? ' on' : ''}`}
            disabled={busy !== null}
            onClick={() => toggleTesting(!testingOn)}
            aria-pressed={testingOn}
          >
            <span className="fa-toggle-knob" />
          </button>
        </div>
      </section>

      {/* Per-flag toggles */}
      <section className="fa-section">
        <h2 className="fa-h2">Per-flag toggles</h2>
        <p className="fa-p">
          Effective values shown reflect what the operator is currently serving.
          {!testingOn && <> When testingFeatures is off, toggles below have no effect — turn it on first.</>}
        </p>
        <div className="fa-flags">
          {ALL_FLAG_KEYS.map((key) => {
            const on = effective[key] ?? false;
            const label = FLAG_LABELS[key];
            const blurb = FLAG_BLURBS[key];
            return (
              <div key={key} className={`fa-flag${!testingOn ? ' disabled' : ''}`}>
                <div className="fa-flag-main">
                  <div className="fa-flag-name">{label}</div>
                  <div className="fa-flag-blurb">{blurb}</div>
                  <div className="fa-flag-key">{key}</div>
                </div>
                <button
                  type="button"
                  className={`fa-toggle${on ? ' on' : ''}`}
                  disabled={!testingOn || busy !== null}
                  onClick={() => toggleFlag(key, !on)}
                  aria-pressed={on}
                  title={!testingOn ? 'Turn on testingFeatures first' : on ? 'Disable' : 'Enable'}
                >
                  <span className="fa-toggle-knob" />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {toast && <div className="fa-toast">{toast}</div>}

      <style>{`
        .fa-shell { padding: 20px; max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 28px; }
        .fa-section { display: flex; flex-direction: column; gap: 8px; }
        .fa-h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-1, #e5e7eb); letter-spacing: 0.02em; text-transform: uppercase; }
        .fa-p { margin: 0; color: var(--text-2, #9ca3af); font-size: 13px; line-height: 1.5; }
        .fa-presets { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 6px; }
        .fa-preset {
          display: flex; flex-direction: column; gap: 6px;
          padding: 16px 14px; min-height: 96px;
          border-radius: 10px;
          background: var(--surface-1, #0f0f0f);
          border: 1px solid var(--border, #2a2a2a);
          color: var(--text-1, #e5e7eb);
          text-align: left;
          cursor: pointer;
          transition: background 120ms, border-color 120ms;
        }
        .fa-preset:hover:not(:disabled) {
          background: var(--surface-2, #161616);
          border-color: var(--border-hover, #3a3a3a);
        }
        .fa-preset.active {
          background: var(--surface-2, #161616);
          border-color: var(--accent, #5b8def);
        }
        .fa-preset:disabled { opacity: 0.6; cursor: progress; }
        .fa-preset-emoji { font-size: 20px; }
        .fa-preset-title { font-size: 15px; font-weight: 600; }
        .fa-preset-blurb { font-size: 12px; color: var(--text-2, #9ca3af); line-height: 1.5; }
        .fa-preset-busy { font-size: 11px; color: var(--text-2, #9ca3af); }
        .fa-master {
          display: flex; align-items: center; gap: 16px;
          padding: 14px 16px;
          border-radius: 10px;
          background: var(--surface-1, #0f0f0f);
          border: 1px solid var(--border, #2a2a2a);
        }
        .fa-master-text { flex: 1; }
        .fa-master-blurb { color: var(--text-2, #9ca3af); font-size: 12px; line-height: 1.5; margin-top: 6px; }
        .fa-source { color: var(--text-3, #6b7280); font-family: ui-monospace, monospace; font-size: 11px; }
        .fa-pill {
          display: inline-block; padding: 1px 8px; border-radius: 999px;
          font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
          margin-left: 8px;
        }
        .fa-pill.on  { background: rgba(34, 197, 94, 0.18); color: #4ade80; }
        .fa-pill.off { background: rgba(107, 114, 128, 0.20); color: #9ca3af; }
        .fa-flags { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
        .fa-flag {
          display: flex; align-items: center; gap: 16px;
          padding: 12px 16px;
          border-radius: 10px;
          background: var(--surface-1, #0f0f0f);
          border: 1px solid var(--border, #2a2a2a);
        }
        .fa-flag.disabled { opacity: 0.55; }
        .fa-flag-main { flex: 1; }
        .fa-flag-name { font-size: 14px; font-weight: 500; color: var(--text-1, #e5e7eb); }
        .fa-flag-blurb { color: var(--text-2, #9ca3af); font-size: 12px; line-height: 1.5; margin-top: 2px; }
        .fa-flag-key { color: var(--text-3, #6b7280); font-family: ui-monospace, monospace; font-size: 11px; margin-top: 2px; }
        .fa-toggle {
          flex: 0 0 auto;
          width: 40px; height: 22px;
          padding: 2px;
          border-radius: 999px;
          background: var(--surface-2, #2a2a2a);
          border: 1px solid var(--border, #3a3a3a);
          position: relative; cursor: pointer;
          transition: background 120ms, border-color 120ms;
        }
        .fa-toggle.on {
          background: #2563eb;
          border-color: #1e40af;
        }
        .fa-toggle:disabled { cursor: not-allowed; }
        .fa-toggle-knob {
          display: block; width: 16px; height: 16px;
          border-radius: 50%;
          background: #f3f4f6;
          transform: translateX(0);
          transition: transform 120ms;
        }
        .fa-toggle.on .fa-toggle-knob { transform: translateX(18px); }
        .fa-toast {
          position: fixed; bottom: 24px; right: 24px;
          padding: 10px 14px;
          border-radius: 8px;
          background: var(--surface-2, #161616);
          border: 1px solid var(--border, #2a2a2a);
          color: var(--text-1, #e5e7eb);
          font-size: 13px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.4);
          z-index: 9999;
        }
        .fa-error { color: #ef4444; padding: 16px; }
        .fa-spinner { color: var(--text-2, #9ca3af); padding: 16px; }
      `}</style>
    </div>
  );
}
