'use client';

/**
 * The client side of the ticket-integrations read and write paths (linear-asana-task-sync P-007,
 * D-014). Settings → Integrations and the /admin/admission "Ticket sources" table share this, so
 * both render the same overview from one read (D-014.7).
 *
 * Read: one GET of /api/user/integrations/tickets resolves the user every route acts for and
 * renders until the live `integrations.tickets` sync query answers; each write route fires
 * notifySyncInvalidate, so nothing polls. Writes go through `integrationRequest`.
 */

import { useEffect, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type {
  TicketIntegrationsOverview,
  TicketSourceConfigKey,
} from '@papercusp/operator-core/lib/integrations/ticket-integrations';

export const INTEGRATIONS_API = '/api/user/integrations/tickets';
export const INTEGRATIONS_QUERY = 'integrations.tickets';
export const INTEGRATIONS_SETTINGS_HREF = '/settings/integrations';

/** A refusal from the integrations routes, carrying the route's error code. */
export class IntegrationRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationRequestError';
  }
}

/** Call an integrations route; a non-2xx or `ok:false` body throws its code and detail. */
export async function integrationRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(INTEGRATIONS_API + path, {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string; detail?: string }) | null;
  if (!res.ok || !json || json.ok === false) {
    throw new IntegrationRequestError(json?.error ?? `http_${res.status}`, json?.detail ?? json?.error ?? `HTTP ${res.status}`);
  }
  return json;
}

export interface TicketIntegrationsState {
  overview: TicketIntegrationsOverview | null;
  loadError: string | null;
}

/** The signed-in user's ticket providers and sources, live. */
export function useTicketIntegrations(): TicketIntegrationsState {
  const [initial, setInitial] = useState<{ userId: string; overview: TicketIntegrationsOverview } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    integrationRequest<TicketIntegrationsOverview & { userId: string }>('')
      .then(({ userId, providers, sources }) => {
        if (!cancelled) setInitial({ userId, overview: { providers, sources } });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const userId = initial?.userId ?? '';
  const live = useSyncQuery<TicketIntegrationsOverview>({
    queryName: INTEGRATIONS_QUERY,
    args: { userId },
    enabled: Boolean(userId),
  });
  return { overview: live.data?.[0] ?? initial?.overview ?? null, loadError };
}

/** How a missing config key reads in "Needs … before it can sync". */
const CONFIG_KEY_LABEL: Record<TicketSourceConfigKey, string> = {
  teamIds: 'teams',
  workspaceGid: 'a workspace',
  projectGids: 'projects',
  sectionCategories: 'a section mapping',
  harnessSlug: 'a harness to store tickets in',
};

export const missingLabels = (keys: string[]): string[] =>
  keys.map((key) => (CONFIG_KEY_LABEL as Record<string, string | undefined>)[key] ?? key);

export function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
