// Server-side flag evaluation. Uses posthog-node with local evaluation —
// no per-call network round trip after initial flag-definition fetch.
// Event capture is explicitly disabled; this client only reads flag state.
//
// If PostHog is unreachable, evaluations fall back to FLAG_DEFAULTS
// (fail-safe-closed — V1 ship state is "everything off").

import { PostHog } from "posthog-node";
import { resolveTestOverrides } from "./test";
import {
  ALL_FLAG_KEYS,
  FLAG_DEFAULTS,
  type FlagKey,
  type FlagPayload,
  type FlagValues,
  resolveWithDefaults,
} from "./types";

export type PostHogConfig = {
  host: string;
  projectKey: string;
  personalApiKey: string;
};

type ChangeHandler = (key: FlagKey | null) => void;

let client: PostHog | null = null;
let config: PostHogConfig | null = null;
const changeHandlers = new Set<ChangeHandler>();

export function initFlagBackend(cfg: PostHogConfig | null): void {
  if (client) {
    void client.shutdown();
    client = null;
  }
  config = cfg;
  if (!cfg) return;
  client = new PostHog(cfg.projectKey, {
    host: cfg.host,
    flushAt: 1_000_000,
    flushInterval: 24 * 60 * 60 * 1000,
    disableGeoip: true,
  });
}

export function isBackendConfigured(): boolean {
  return client !== null;
}

export function getBackendConfig(): PostHogConfig | null {
  return config;
}

export async function getFlag(
  key: FlagKey,
  distinctId: string,
): Promise<boolean> {
  const overrides = resolveTestOverrides();
  if (overrides) return overrides[key];
  if (!client) return FLAG_DEFAULTS[key];
  try {
    const v = await client.isFeatureEnabled(key, distinctId);
    return typeof v === "boolean" ? v : FLAG_DEFAULTS[key];
  } catch {
    return FLAG_DEFAULTS[key];
  }
}

export async function getAllFlags(distinctId: string): Promise<FlagPayload> {
  const overrides = resolveTestOverrides();
  if (overrides) {
    return { flags: overrides, evaluatedAt: Date.now(), source: "override" };
  }
  if (!client) {
    return {
      flags: { ...FLAG_DEFAULTS },
      evaluatedAt: Date.now(),
      source: "defaults",
    };
  }
  const evaluated: Partial<Record<FlagKey, boolean>> = {};
  await Promise.all(
    ALL_FLAG_KEYS.map(async (key) => {
      try {
        const v = await client!.isFeatureEnabled(key, distinctId);
        if (typeof v === "boolean") evaluated[key] = v;
      } catch {
        // leave undefined; resolveWithDefaults fills with FLAG_DEFAULTS[key]
      }
    }),
  );
  const flags: FlagValues = resolveWithDefaults(evaluated);
  return { flags, evaluatedAt: Date.now(), source: "posthog" };
}

export async function setFlag(
  key: FlagKey,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!config) return { ok: false, reason: "flag-backend-not-configured" };
  const url = `${config.host}/api/projects/@current/feature_flags/`;
  try {
    const listRes = await fetch(`${url}?search=${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${config.personalApiKey}` },
    });
    if (!listRes.ok) return { ok: false, reason: `list:${listRes.status}` };
    const list = (await listRes.json()) as { results?: Array<{ id: number; key: string; active: boolean }> };
    const hit = list.results?.find((f) => f.key === key);
    if (!hit) return { ok: false, reason: "flag-not-found-in-posthog" };
    if (hit.active === enabled) return { ok: true };
    const patchRes = await fetch(`${url}${hit.id}/`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.personalApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ active: enabled }),
    });
    if (!patchRes.ok) return { ok: false, reason: `patch:${patchRes.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unknown" };
  }
}

export function onFlagChange(handler: ChangeHandler): () => void {
  changeHandlers.add(handler);
  return () => changeHandlers.delete(handler);
}

export function emitFlagChange(key: FlagKey | null): void {
  for (const h of changeHandlers) {
    try {
      h(key);
    } catch {
      // swallow handler errors; never block the dispatch loop
    }
  }
}
