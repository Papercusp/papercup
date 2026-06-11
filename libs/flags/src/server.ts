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

/**
 * Persistent runtime overrides (audit P-070, EI-76). The host injects a
 * store (Papercusp wires a PG-backed one in operator-core's flag-bus) so
 * /api/flags/set can flip flags at runtime WITHOUT PostHog — previously a
 * dev box needed a process restart per PAPERCUSP_FLAG_* env flip.
 *
 * Precedence: env var > in-process test overrides > stored override >
 * PostHog > FLAG_DEFAULTS. The store is read through a short TTL cache so
 * per-call flag checks don't each pay a PG round trip; setFlagOverride
 * invalidates the cache immediately.
 */
export type FlagOverrideStore = {
  /** Current override map; missing keys = no override. */
  load(): Promise<Partial<Record<FlagKey, boolean>>>;
  /** Persist one override; `null` clears it. */
  set(key: FlagKey, enabled: boolean | null): Promise<void>;
};

let overrideStore: FlagOverrideStore | null = null;
let overrideCache: { flags: Partial<Record<FlagKey, boolean>>; ts: number } | null = null;
const OVERRIDE_CACHE_TTL_MS = 5_000;

export function initFlagOverrideStore(store: FlagOverrideStore | null): void {
  overrideStore = store;
  overrideCache = null;
}

export function isOverrideStoreConfigured(): boolean {
  return overrideStore !== null;
}

async function loadStoredOverrides(): Promise<Partial<Record<FlagKey, boolean>>> {
  if (!overrideStore) return {};
  const t = Date.now();
  if (overrideCache && t - overrideCache.ts < OVERRIDE_CACHE_TTL_MS) {
    return overrideCache.flags;
  }
  try {
    const flags = await overrideStore.load();
    overrideCache = { flags, ts: t };
    return flags;
  } catch {
    // Store unreachable — serve the last good map (or none); never block
    // flag evaluation on the override layer.
    return overrideCache?.flags ?? {};
  }
}

export async function setFlagOverride(
  key: FlagKey,
  enabled: boolean | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!overrideStore) return { ok: false, reason: "override-store-not-configured" };
  try {
    await overrideStore.set(key, enabled);
    overrideCache = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unknown" };
  }
}

export function initFlagBackend(cfg: PostHogConfig | null): void {
  if (client) {
    void client.shutdown();
    client = null;
  }
  config = cfg;
  if (!cfg) return;
  client = new PostHog(cfg.projectKey, {
    host: cfg.host,
    personalApiKey: cfg.personalApiKey,
    flushAt: 1_000_000,
    flushInterval: 24 * 60 * 60 * 1000,
    featureFlagsPollingInterval: 10_000,
    disableGeoip: true,
  });
}

export function isBackendConfigured(): boolean {
  return client !== null;
}

export function getBackendConfig(): PostHogConfig | null {
  return config;
}

/**
 * Env-var override: `PAPERCUSP_FLAG_<KEY>=1` flips a single flag on
 * without needing PostHog or in-process test overrides. Useful in dev
 * when PostHog isn't configured but you want to exercise a gated
 * feature (e.g. the llm-testing framework running oracle scenarios).
 * The key is uppercased and `-` is converted to `_`.
 */
function resolveEnvOverride(key: FlagKey): boolean | undefined {
  const envKey = `PAPERCUSP_FLAG_${key.toUpperCase().replace(/-/g, "_")}`;
  const raw = process.env[envKey];
  if (raw === undefined) return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

export async function getFlag(
  key: FlagKey,
  distinctId: string,
): Promise<boolean> {
  const envOverride = resolveEnvOverride(key);
  if (envOverride !== undefined) return envOverride;
  const overrides = resolveTestOverrides();
  if (overrides) return overrides[key];
  const stored = await loadStoredOverrides();
  if (stored[key] !== undefined) return stored[key] as boolean;
  if (!client) return FLAG_DEFAULTS[key];
  try {
    const v = await client.isFeatureEnabled(key, distinctId);
    return typeof v === "boolean" ? v : FLAG_DEFAULTS[key];
  } catch {
    return FLAG_DEFAULTS[key];
  }
}

/**
 * Overlay `PAPERCUSP_FLAG_<KEY>` env overrides onto a full flag map — the
 * all-flags counterpart of the env check in getFlag, with the same precedence
 * (env beats test overrides / PostHog / defaults). Without this, the documented
 * dev override flipped server-side single-flag checks but was invisible to the
 * client bootstrap payload (`useFlag`), so UI gates never saw it.
 */
function applyEnvOverrides(flags: FlagValues): FlagValues {
  let out = flags;
  for (const key of ALL_FLAG_KEYS) {
    const v = resolveEnvOverride(key);
    if (v !== undefined) {
      if (out === flags) out = { ...flags };
      out[key] = v;
    }
  }
  return out;
}

export async function getAllFlags(distinctId: string): Promise<FlagPayload> {
  const overrides = resolveTestOverrides();
  if (overrides) {
    return { flags: applyEnvOverrides(overrides), evaluatedAt: Date.now(), source: "override" };
  }
  // Filter the stored map through resolveWithDefaults: the PG row can carry
  // keys for RETIRED flags (e.g. papercusp-oracle after the 2026-06-10 fold),
  // and a raw spread would leak them into every client payload forever.
  const stored = await loadStoredOverrides();
  if (!client) {
    return {
      flags: applyEnvOverrides(resolveWithDefaults(stored)),
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
  // stored beats evaluated; resolveWithDefaults drops retired/unknown keys.
  const flags: FlagValues = applyEnvOverrides(
    resolveWithDefaults({ ...evaluated, ...stored }),
  );
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
    // PostHog evaluates a flag as true only when both `active` is true
    // AND the rollout matches the user. We want a binary on/off switch
    // for all users, so we set rollout_percentage=100 when enabling and
    // 0 when disabling, in addition to flipping `active`.
    const rollout = enabled ? 100 : 0;
    const patchRes = await fetch(`${url}${hit.id}/`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.personalApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        active: enabled,
        filters: { groups: [{ properties: [], rollout_percentage: rollout }] },
      }),
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
