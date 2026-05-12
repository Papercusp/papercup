/**
 * In-process feature-flag change bus.
 *
 * The PostHog webhook endpoint (POST /api/flags/webhook) writes to this
 * channel; the SSE stream (GET /api/flags/stream) reads from it. Sub-
 * millisecond fan-out via @restart/sse's getChannel.
 *
 * Also handles one-time backend initialization: on first import the
 * module reads ~/.papercusp/posthog.json (or env overrides) and calls
 * initFlagBackend(). If no config is present, the backend stays in
 * fallback mode and every evaluation returns FLAG_DEFAULTS.
 */
import { getChannel } from '@restart/sse';

import {
  emitFlagChange,
  initFlagBackend,
  isBackendConfigured,
} from '@papercusp/flags/server';
import type { FlagKey } from '@papercusp/flags';

import { getPosthogConfig } from './posthog-config';

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
  if (!isBackendConfigured()) {
    initFlagBackend(getPosthogConfig());
  }
}

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
