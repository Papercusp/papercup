'use client';

/**
 * DesktopAttentionNotifier — the desktop-native consumer of attention pushes
 * (planning-attention-importance-2026-05-31, D-007).
 *
 * Subscribes to the sync SSE bus for `attention.notify` events (emitted by
 * notifyAttention on the operator side at the ≥high attention sources) and
 * surfaces each one two ways, both fail-safe:
 *   1. an in-app sonner toast — always (works in the browser and the desktop
 *      webview, visible the moment it fires);
 *   2. in the Tauri desktop only, a native OS notification via the
 *      `show_attention_notification` Rust command (tauri-plugin-notification),
 *      so the human is pinged even when the window is backgrounded.
 *
 * Lives at the app level (NOT in the generic @papercusp/sync lib, which stays
 * domain-free) and is mounted once at the root. The SSE frames named
 * `invalidate` / `update` events whose JSON payload is `{ name, args }`; an
 * attention push rides as `name === 'attention.notify'`.
 */
import { useEffect } from 'react';
import { toast } from 'sonner';

const ATTENTION_NOTIFY_EVENT = 'attention.notify';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface NotifyArgs {
  title?: string;
  body?: string;
  kind?: string;
  importance?: string;
  harnessSlug?: string | null;
}

export default function DesktopAttentionNotifier() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onEvent = (e: MessageEvent) => {
      let payload: { name?: string; args?: NotifyArgs };
      try {
        payload = JSON.parse(e.data) as { name?: string; args?: NotifyArgs };
      } catch {
        return;
      }
      if (payload?.name !== ATTENTION_NOTIFY_EVENT) return;
      const a = payload.args ?? {};
      const title = a.title || 'Needs your attention';
      const body = a.body || '';

      // 1. In-app toast — always. urgent → error styling.
      if (a.importance === 'urgent') toast.error(title, { description: body });
      else toast(title, { description: body });

      // 2. Native OS notification — desktop only, fail-safe. The Rust command
      // is absent until the desktop is rebuilt with tauri-plugin-notification;
      // the catch keeps that a no-op (the toast already fired).
      if (isTauri()) {
        void (async () => {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('show_attention_notification', { title, body });
        })().catch(() => {
          /* command missing (pre-rebuild) or permission denied — toast stands */
        });
      }
    };

    // Resilient connect. A raw EventSource opened during the operator-vite
    // SPA's initial mount can fail to ever fire `open` in the desktop webview
    // (the :3070 sidecar/SSE route isn't ready that early) and stay stuck in
    // CONNECTING *without* an `error` event — verified live, session e36df27a:
    // the component mounts but its stream never opens, so the notifier is
    // silently deaf. We therefore (a) recreate on any pre-open `error`, and
    // (b) run a watchdog that recreates if the stream hasn't reached OPEN
    // within a grace window. Once OPEN, the browser's own retry handles drops.
    const OPEN_GRACE_MS = 4000;
    const RETRY_MS = 3000;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const clearTimers = () => {
      if (retry) { clearTimeout(retry); retry = null; }
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    };

    const recreate = () => {
      if (stopped || retry) return;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (es) { es.close(); es = null; }
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, RETRY_MS);
    };

    function connect() {
      if (stopped) return;
      try {
        es = new EventSource('/api/zero-harness/sse');
      } catch {
        recreate();
        return;
      }
      es.addEventListener('invalidate', onEvent);
      es.addEventListener('update', onEvent);
      es.onopen = () => {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (retry) { clearTimeout(retry); retry = null; }
      };
      es.onerror = () => {
        // Only intervene if it never opened; a transient drop on an OPEN
        // stream is the browser's job to retry.
        if (es && es.readyState !== EventSource.OPEN) recreate();
      };
      // Watchdog for the silent-stuck case (no error, no open).
      watchdog = setTimeout(() => {
        watchdog = null;
        if (!stopped && (!es || es.readyState !== EventSource.OPEN)) recreate();
      }, OPEN_GRACE_MS);
    }

    connect();

    return () => {
      stopped = true;
      clearTimers();
      es?.close();
    };
  }, []);

  return null;
}
