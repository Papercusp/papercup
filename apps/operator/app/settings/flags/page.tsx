'use client';

/**
 * Feature flags settings - read-only view of the resolved flag state.
 *
 * Flag values are the source of truth in PostHog. Toggle them in the
 * PostHog dashboard; the SSE stream on /api/flags/stream will push the
 * change here within seconds.
 *
 * This page intentionally does not write to PostHog. The corresponding
 * MCP tools (flags_list, flag_set) do, so agents have a programmatic
 * surface; humans use the PostHog UI.
 */
import { useEffect, useState } from 'react';

import type { FlagKey, FlagPayload, FlagValues } from '@papercusp/flags';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';

const FLAG_DESCRIPTIONS: Record<FlagKey, string> = {
  [FLAGS.SNAPSHOTS]:          'Harness snapshot save/restore.',
  [FLAGS.TEMPLATES]:          'Harness template save/load.',
  [FLAGS.MARKETPLACE]:        'Plugin / template / snapshot marketplace.',
  [FLAGS.CLOUDFLARE_PUBLISH]: 'Publish-to-Cloudflare flow under Settings -> Publishing.',
  [FLAGS.ORACLE]:             'Oracle tutorial / general-help dialog.',
  [FLAGS.RUST_PORT_UI]:       'Dev-only Rust port status surfaces.',
  [FLAGS.HARNESS_PHASES]:     'Multi-phase harness (staging / testing / production).',
};

const FLAG_ENTRIES: Array<{ key: FlagKey; label: string }> = [
  { key: FLAGS.SNAPSHOTS,          label: 'Snapshots' },
  { key: FLAGS.TEMPLATES,          label: 'Templates' },
  { key: FLAGS.MARKETPLACE,        label: 'Marketplace' },
  { key: FLAGS.CLOUDFLARE_PUBLISH, label: 'Cloudflare publishing' },
  { key: FLAGS.ORACLE,             label: 'Oracle dialog' },
  { key: FLAGS.RUST_PORT_UI,       label: 'Rust-port surfaces' },
  { key: FLAGS.HARNESS_PHASES,     label: 'Harness phases' },
];

const POSTHOG_DASHBOARD_URL = '/api/flags/dashboard-url';

type FetchState =
  | { kind: 'loading' }
  | { kind: 'ok'; payload: FlagPayload }
  | { kind: 'error'; message: string };

type LiveState =
  | { kind: 'loading' }
  | { kind: 'ok'; testingFeatures: boolean; source: string }
  | { kind: 'error'; message: string };

export default function FeatureFlagsPage() {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const [liveState, setLiveState] = useState<LiveState>({ kind: 'loading' });
  const [dashboardUrl, setDashboardUrl] = useState<string | null>(null);

  const refreshLive = async () => {
    try {
      const res = await fetch('/api/flags/testing-features', { cache: 'no-store' });
      const j = (await res.json()) as { testingFeatures: boolean; source: string };
      setLiveState({ kind: 'ok', ...j });
    } catch (err) {
      setLiveState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'unknown',
      });
    }
  };

  const toggleLive = async (next: boolean) => {
    const res = await fetch('/api/flags/testing-features', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (res.ok) {
      void refreshLive();
    }
  };

  useEffect(() => {
    void refreshLive();
  }, []);

  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      try {
        const res = await fetch('/api/flags/bootstrap', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as FlagPayload;
        if (alive) setState({ kind: 'ok', payload });
      } catch (err) {
        if (alive) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    };

    void refresh();

    fetch(POSTHOG_DASHBOARD_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => alive && setDashboardUrl((j as { url?: string } | null)?.url ?? null))
      .catch(() => {});

    const es = new EventSource('/api/flags/stream');
    es.addEventListener('flag_changed', () => {
      void refresh();
    });

    return () => {
      alive = false;
      es.close();
    };
  }, []);

  return (
    <section className="space-y-4 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Feature flags</h1>
          <p className="text-sm text-neutral-500">
            Resolved values for this machine. Read-only here - toggle them in PostHog.
          </p>
        </div>
        {dashboardUrl ? (
          <a
            href={dashboardUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded border px-3 py-1.5 text-sm hover:bg-neutral-50"
          >
            Open PostHog dashboard -&gt;
          </a>
        ) : null}
      </header>

      <TestingFeaturesCard state={liveState} onToggle={toggleLive} />

      {state.kind === 'loading' ? <p className="text-sm">Loading...</p> : null}
      {state.kind === 'error' ? (
        <p className="text-sm text-red-600">Failed to load flags: {state.message}</p>
      ) : null}

      {state.kind === 'ok' ? (
        <FlagTable values={state.payload.flags} source={state.payload.source} />
      ) : null}
    </section>
  );
}

function FlagTable({
  values,
  source,
}: {
  values: FlagValues;
  source: FlagPayload['source'];
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs uppercase tracking-wide text-neutral-500">
        Source: <span className="font-mono">{source}</span>
      </p>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="py-2 pr-4">Flag</th>
            <th className="py-2 pr-4">Key</th>
            <th className="py-2 pr-4">State</th>
            <th className="py-2 pr-4">Default</th>
            <th className="py-2 pr-4">Description</th>
          </tr>
        </thead>
        <tbody>
          {FLAG_ENTRIES.map(({ key, label }) => {
            const active = values[key];
            const defaultValue = FLAG_DEFAULTS[key];
            return (
              <tr key={key} className="border-t">
                <td className="py-2 pr-4 font-medium">{label}</td>
                <td className="py-2 pr-4 font-mono text-xs text-neutral-500">{key}</td>
                <td className="py-2 pr-4">
                  <span
                    className={
                      active
                        ? 'rounded bg-emerald-100 px-2 py-0.5 text-emerald-700'
                        : 'rounded bg-neutral-100 px-2 py-0.5 text-neutral-600'
                    }
                  >
                    {active ? 'on' : 'off'}
                  </span>
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-neutral-500">
                  {defaultValue ? 'on' : 'off'}
                </td>
                <td className="py-2 pr-4 text-neutral-600">{FLAG_DESCRIPTIONS[key]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TestingFeaturesCard({
  state,
  onToggle,
}: {
  state: LiveState;
  onToggle: (next: boolean) => void;
}) {
  if (state.kind === 'loading') return null;
  if (state.kind === 'error') {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        Could not read testing-features state: {state.message}
      </div>
    );
  }
  const on = state.testingFeatures;
  return (
    <div className="rounded border bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="font-medium">
            Live feature-flag updates:{' '}
            <span className={on ? 'text-emerald-600' : 'text-neutral-500'}>
              {on ? 'on' : 'off (offline)'}
            </span>
          </div>
          <p className="text-sm text-neutral-600">
            {on
              ? 'Your operator is fetching flag definitions from flags.papercuspai.com. No analytics, replay, or telemetry are sent.'
              : 'No network calls to PostHog are being made. The bundled defaults (V1 ship state) are in effect.'}
          </p>
          <p className="text-xs text-neutral-400">
            Discovery source: <span className="font-mono">{state.source}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => onToggle(!on)}
          className={
            on
              ? 'rounded border bg-neutral-100 px-3 py-1.5 text-sm hover:bg-neutral-200'
              : 'rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700'
          }
        >
          {on ? 'Disable live updates' : 'Enable live updates'}
        </button>
      </div>
    </div>
  );
}
