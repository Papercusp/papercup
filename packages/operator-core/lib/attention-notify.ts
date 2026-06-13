/**
 * notifyAttention — the single delivery path for "ping the human now" events
 * (planning-attention-importance-2026-05-31, P-020/P-021/D-007).
 *
 * Replaces the device-intervention-watcher 60s poll (P-021): producers call
 * this at the source (the /api/internal/*-event endpoints, plans:set-status)
 * the moment a ≥high attention item appears, instead of a timer scanning PG.
 *
 * Two channels, each independently fail-safe (a delivery error is logged and
 * swallowed — it must never propagate into the producer's write path):
 *   1. mobile  — notifyWorkspace → APNs/FCM to paired devices (no-op when
 *                none are paired).
 *   2. desktop — an `attention.notify` event on the existing sync SSE bus
 *                (notifySyncInvalidate) that the webview turns into a native
 *                OS notification via tauri-plugin-notification (D-007). The
 *                event is harmless when no desktop consumer is listening.
 *
 * Callers own the importance gate: needs-human emits only at ≥high; the
 * escalation / smoke-fail producers are inherently high so they
 * always notify. The helper does not re-gate.
 */
import { notifyWorkspace, type PushKind } from './device-push-dispatcher';
import { notifySyncInvalidate } from './sync-sse';
import { activeWorkspaceId } from './workspace-registry';

export type AttentionNotifyKind = 'needs-human' | 'intervention' | 'smoke-fail';

/** Fine-grained kind → the mobile PushKind the app's push-routing understands
 *  (needs-human has no dedicated mobile route yet → folds into intervention). */
const MOBILE_KIND: Record<AttentionNotifyKind, PushKind> = {
  'needs-human': 'intervention',
  intervention: 'intervention',
  'smoke-fail': 'smoke-fail',
};

/** SSE event name the desktop webview listens for to raise a native notification. */
export const ATTENTION_NOTIFY_EVENT = 'attention.notify';

export interface AttentionNotifyInput {
  kind: AttentionNotifyKind;
  title: string;
  body: string;
  harnessSlug?: string;
  /** urgent | high | normal | low — carried for routing/styling, not gated here. */
  importance?: string;
  /** Extra routing data merged into both channels. */
  data?: Record<string, unknown>;
  /** Override the target workspace; defaults to the active workspace. */
  workspaceId?: string;
}

export async function notifyAttention(input: AttentionNotifyInput): Promise<void> {
  const ws = input.workspaceId ?? activeWorkspaceId();

  // 1. Mobile (APNs/FCM) — no-op when no device is paired. `data` must be
  // string-valued (APNs/FCM constraint); coerce extras and drop nullish.
  const mobileData: Record<string, string> & { kind?: PushKind } = { kind: MOBILE_KIND[input.kind] };
  if (input.harnessSlug) mobileData.harness = input.harnessSlug;
  if (input.importance) mobileData.importance = input.importance;
  for (const [k, val] of Object.entries(input.data ?? {})) {
    if (val != null) mobileData[k] = String(val);
  }
  try {
    await notifyWorkspace(ws, {
      title: input.title,
      body: input.body,
      data: mobileData,
      category: MOBILE_KIND[input.kind],
    });
  } catch (e) {
    console.warn('[attention-notify] mobile push failed:', (e as Error)?.message ?? e);
  }

  // 2. Desktop-native (D-007) — SSE event the webview renders via Tauri.
  try {
    await notifySyncInvalidate(ATTENTION_NOTIFY_EVENT, {
      kind: input.kind,
      title: input.title,
      body: input.body,
      harnessSlug: input.harnessSlug ?? null,
      importance: input.importance ?? null,
      ...input.data,
    });
  } catch (e) {
    console.warn('[attention-notify] desktop notify failed:', (e as Error)?.message ?? e);
  }
}
