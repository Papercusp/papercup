// Client-side flag reader. NO PostHog import — never. This module is
// safe to bundle in browser / Tauri webview / mobile clients.
//
// Source of truth is the Papercusp backend's /api/flags/bootstrap endpoint.
// SSR pages may inject the initial payload via window.__PAPERCUSP_FLAGS__.
// Live updates arrive on /api/flags/stream (SSE).

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

export function useFlag(key: FlagKey): boolean {
  return current.flags[key] ?? FLAG_DEFAULTS[key];
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
