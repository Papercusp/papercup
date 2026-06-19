/**
 * In-process feature-flag change bus.
 *
 * The PostHog webhook endpoint (POST /api/flags/webhook) writes to this
 * channel; the SSE stream (GET /api/flags/stream) reads from it. Sub-
 * millisecond fan-out via @papercusp/sse's getChannel.
 *
 * Also handles one-time backend initialization: on first import the
 * module reads ~/.papercusp/posthog.json (or env overrides) and calls
 * initFlagBackend(). If no config is present, the backend stays in
 * fallback mode and every evaluation returns FLAG_DEFAULTS.
 */
import { getChannel } from '@papercusp/sse';

import {
  emitFlagChange,
  initFlagBackend,
  initFlagOverrideStore,
  isBackendConfigured,
} from '@papercusp/flags/server';
import type { FlagKey } from '@papercusp/flags';

import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { activeWorkspaceId } from './workspace-registry';

import {
  getPosthogConfig,
  isTestingFeaturesEnabled,
  setOnConfigChange,
  watchPosthogConfig,
} from './posthog-config';

// Boot the server-side lexicon brand-pack selector with the flag subsystem:
// it subscribes to flag changes (emitFlagChange, below) to keep its cached
// active pack fresh. Side-effect import — see ./lexicon/configure.
import './lexicon/configure';

export type FlagChangeEnvelope = {
  type: 'flag_changed';
  key: FlagKey | null;
  ts: number;
};

const CHANNEL = 'feature-flag-changes';

let booted = false;

function bootIfNeeded(): void {
  if (booted) return;
  booted = true;
  // Privacy-first opt-in: only initialize the PostHog client when the
  // user (or CI) has explicitly enabled live updates. Otherwise we
  // never touch the network and getAllFlags() returns FLAG_DEFAULTS,
  // which IS the V1 ship state.
  if (!isBackendConfigured() && isTestingFeaturesEnabled()) {
    initFlagBackend(getPosthogConfig());
  }
}

/**
 * Re-evaluate backend init state. Call after writing the discovery
 * file (and after `resetPosthogConfigForTest()`) — otherwise the
 * one-shot `booted` latch keeps the original "no backend" state
 * regardless of subsequent testingFeatures toggles.
 *
 * Also called automatically by the discovery-file watcher when
 * ~/.papercusp/posthog.json changes on disk.
 */
export function reinitFlagBackend(): void {
  // Unconditionally tear down + rebuild so callers can use this as
  // a "force resync" primitive — fixes the silent-drift case where
  // the SDK client died (HMR / OOM / network reset) but
  // isBackendConfigured() returns stale state. initFlagBackend(null)
  // safely no-ops when client is already null.
  initFlagBackend(null);
  if (isTestingFeaturesEnabled()) {
    initFlagBackend(getPosthogConfig());
  }
  booted = true;
  // Tell every connected client to refetch so they see the new state.
  publishFlagChange(null);
}

// Install the discovery-file watcher on first import so config edits
// take effect without an operator restart.
setOnConfigChange(() => reinitFlagBackend());
watchPosthogConfig();

// PG-backed runtime overrides (audit P-070, EI-76): registered
// unconditionally — independent of the PostHog opt-in — so a dev box with
// no PostHog can flip flags at runtime via /api/flags/set instead of a
// PAPERCUSP_FLAG_* env var + process restart. The flags lib layers these
// between test overrides and PostHog, behind a short read cache.
initFlagOverrideStore({
  // Partition the override read-cache by workspace: load() reads
  // `WHERE workspace_id = activeWorkspaceId()`, so without this the first
  // workspace to load would serve its overrides to every other workspace
  // for the cache TTL (a cross-workspace flag bleed).
  cacheKey: () => activeWorkspaceId(),
  async load() {
    return (
      (await readOperatorState<Partial<Record<FlagKey, boolean>>>(
        'operator_flag_overrides',
      )) ?? {}
    );
  },
  async set(key, enabled) {
    const current =
      (await readOperatorState<Partial<Record<FlagKey, boolean>>>(
        'operator_flag_overrides',
      )) ?? {};
    if (enabled === null) delete current[key];
    else current[key] = enabled;
    await writeOperatorState('operator_flag_overrides', current);
  },
});

export function getFlagBus() {
  bootIfNeeded();
  return getChannel<FlagChangeEnvelope>(CHANNEL, { ringSize: 64 });
}

export function publishFlagChange(key: FlagKey | null = null): void {
  const ch = getFlagBus();
  const env: FlagChangeEnvelope = { type: 'flag_changed', key, ts: Date.now() };
  ch.publish(env);
  emitFlagChange(key);
}
