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
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/zero-harness/sse');
    } catch {
      return; // SSE unavailable — sync layer handles its own retries
    }

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

    es.addEventListener('invalidate', onEvent);
    es.addEventListener('update', onEvent);
    return () => {
      es?.close();
    };
  }, []);

  return null;
}
