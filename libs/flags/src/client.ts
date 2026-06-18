// Client-side flag reader. NO PostHog import — never. This module is
// safe to bundle in browser / Tauri webview / mobile clients.
//
// Source of truth is the Papercusp backend's /api/flags/bootstrap endpoint.
// SSR pages may inject the initial payload via window.__PAPERCUSP_FLAGS__.
// Live updates arrive on /api/flags/stream (SSE).

import { useSyncExternalStore } from "react";
import { createResilientEventSource } from "@papercusp/sse";
import {
  FLAG_DEFAULTS,
  type FlagKey,
  type FlagPayload,
  type FlagValues,
  resolveWithDefaults,
} from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __PAPERCUSP_FLAGS__: FlagPayload | undefined;
}

type Listener = (flags: FlagValues) => void;

let current: FlagPayload = readInitialPayload();
const listeners = new Set<Listener>();

function readInitialPayload(): FlagPayload {
  if (typeof globalThis !== "undefined" && globalThis.__PAPERCUSP_FLAGS__) {
    const seed = globalThis.__PAPERCUSP_FLAGS__;
    return {
      flags: resolveWithDefaults(seed.flags),
      evaluatedAt: seed.evaluatedAt,
      source: seed.source,
    };
  }
  return {
    flags: { ...FLAG_DEFAULTS },
    evaluatedAt: 0,
    source: "defaults",
  };
}

/**
 * Plain, non-reactive read of a single flag (the current store value resolved
 * against FLAG_DEFAULTS). For non-React contexts — route guards, tests, one-shot
 * reads. React components want the reactive `useFlag` instead.
 */
export function getFlag(key: FlagKey): boolean {
  return current.flags[key] ?? FLAG_DEFAULTS[key];
}

export function useFlag(key: FlagKey): boolean {
  // Reactive read: subscribe to the shared store so a LIVE flag change
  // (a dev-rail FlagsPanel toggle → /api/flags/set → SSE → setFlagPayload, or
  // any setFlagPayload/loadFlags) re-renders the consumer immediately, instead
  // of going stale until a full page reload. Before this, useFlag was a plain
  // read of `current` with no subscription, so toggling a flag never reached
  // the gated UI. The snapshot is a primitive boolean, so useSyncExternalStore's
  // Object.is check only re-renders on an actual flip. (flag-reactivity 2026-06-18)
  const read = (): boolean => getFlag(key);
  return useSyncExternalStore(subscribe, read, read);
}

export function getFlagSnapshot(): FlagPayload {
  return current;
}

export async function loadFlags(
  endpoint = "/api/flags/bootstrap",
): Promise<FlagPayload> {
  const res = await fetch(endpoint, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`loadFlags: HTTP ${res.status}`);
  const data = (await res.json()) as FlagPayload;
  setFlagPayload(data);
  return current;
}

export function setFlagPayload(payload: FlagPayload): void {
  current = {
    flags: resolveWithDefaults(payload.flags),
    evaluatedAt: payload.evaluatedAt,
    source: payload.source,
  };
  for (const l of listeners) l(current.flags);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type StreamSubscription = { close(): void };

export function subscribeToFlagStream(
  endpoint = "/api/flags/stream",
): StreamSubscription {
  if (typeof EventSource === "undefined") {
    return { close: () => {} };
  }
  const source = createResilientEventSource({
    url: endpoint,
    withCredentials: true,
    handlers: {
      flag_changed: () => {
        void loadFlags().catch(() => {
          // network errors are non-fatal; we keep using the cached payload
        });
      },
      flags_payload: (data) => {
        try {
          const payload = JSON.parse(data) as FlagPayload;
          setFlagPayload(payload);
        } catch {
          // ignore malformed events
        }
      },
    },
  });
  return {
    close: () => source.close(),
  };
}
