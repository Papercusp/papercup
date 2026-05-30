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
  isBackendConfigured,
} from '@papercusp/flags/server';
import type { FlagKey } from '@papercusp/flags';

import {
  getPosthogConfig,
  isTestingFeaturesEnabled,
  setOnConfigChange,
  watchPosthogConfig,
} from './posthog-config';

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
