'use client';

// Shared implementation of the operator's existing browser consent boundary.
// An unavailable host endpoint drops events; it never implies consent.
import { useEffect, type ReactNode } from 'react';
import { pinModuleState } from '@papercusp/module-singleton';

interface TelemetryConfig {
  enabled: boolean;
  host?: string;
  project_key?: string;
  distinct_id?: string;
  workspace_id?: string;
}
type Client = typeof import('posthog-js').default;
const state = pinModuleState('@papercusp/operator-ui.browser-telemetry', () => ({
  client: null as Client | null,
  initializing: null as Promise<Client> | null,
}));

async function consentedClient(cancelled: () => boolean = () => false) {
  const response = await fetch('/api/desktop/telemetry-config', { cache: 'no-store' });
  if (!response.ok) return null;
  const config = await response.json() as TelemetryConfig;
  if (cancelled() || config.enabled !== true || !config.host || !config.project_key) return null;
  if (state.client) return state.client;
  state.initializing ??= import('posthog-js').then(module => {
    const client = module.default;
    client.init(config.project_key!, {
      api_host: config.host, person_profiles: 'identified_only',
      capture_pageview: true, capture_pageleave: true, autocapture: true,
      disable_session_recording: true,
      loaded: value => value.identify(config.distinct_id ?? config.workspace_id ?? 'default'),
    });
    state.client = client;
    return client;
  }).finally(() => { state.initializing = null; });
  return state.initializing;
}

/** Recheck consent for every explicit event. No queue, opt-in or replay change. */
export async function captureBrowserTelemetry(event: string, properties: Record<string, string | number | boolean>): Promise<void> {
  try {
    const client = await consentedClient();
    client?.capture(event, properties);
  } catch { /* Optional diagnostics cannot interrupt the product. */ }
}

export function PostHogProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (state.client) return;
    let cancelled = false;
    void consentedClient(() => cancelled).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return <>{children}</>;
}
