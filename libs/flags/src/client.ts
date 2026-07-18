// Client-side flag reader. NO PostHog import — never. This module is
// safe to bundle in browser / Tauri webview / mobile clients.
//
// Source of truth is the Papercusp backend's /api/flags/bootstrap endpoint.
// SSR pages may inject the initial payload via window.__PAPERCUSP_FLAGS__.
// Live updates arrive on /api/flags/stream (SSE).

import { useSyncExternalStore } from "react";
import {
  createResilientEventSource,
  type ResilientEventSourceStatus,
} from "@papercusp/sse";
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
 * EI-2425 fix A: a REACTIVE flag read. Before this, `useFlag` was a plain
 * function reading the module-level `current` snapshot — it read the value
 * once at render time but never re-rendered a consumer when `setFlagPayload`
 * later updated `current` (a flag flip via flags:set, or an SSE
 * `flag_changed` push once fix B wires the stream). `useSyncExternalStore`
 * over the existing `subscribe`/`current` primitives makes every `useFlag`
 * consumer re-render the instant the flag changes, with no extra wiring per
 * call site. `getServerSnapshot` falls back to FLAG_DEFAULTS — matches
 * `readInitialPayload`'s own no-window fallback, so an SSR/non-browser
 * evaluation never throws for lack of `subscribe`.
 */
export function useFlag(key: FlagKey): boolean {
  return useSyncExternalStore(
    (onStoreChange) => subscribe(() => onStoreChange()),
    () => current.flags[key] ?? FLAG_DEFAULTS[key],
    () => FLAG_DEFAULTS[key],
  );
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

export interface SubscribeToFlagStreamHooks {
  /** Called when the flag stream proves the origin reachable (SSE opened). */
  onOpen?: () => void;
  /**
   * Called on every resilient-event-source status change, including
   * transient reconnect blips ('failing'). App-level callers use this to
   * feed a shared connectivity signal — kept optional/pass-through so this
   * package stays framework- and app-agnostic.
   */
  onStatusChange?: (status: ResilientEventSourceStatus) => void;
}

export function subscribeToFlagStream(
  endpoint = "/api/flags/stream",
  hooks?: SubscribeToFlagStreamHooks,
): StreamSubscription {
  if (typeof EventSource === "undefined") {
    return { close: () => {} };
  }
  const source = createResilientEventSource({
    url: endpoint,
    withCredentials: true,
    onOpen: hooks?.onOpen,
    onStatusChange: hooks?.onStatusChange,
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
