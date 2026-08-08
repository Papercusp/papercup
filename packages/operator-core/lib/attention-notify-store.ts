/**
 * Durable audit trail for notifyAttention() (WI-36644).
 *
 * notifyAttention is the single "ping the human now" rail — ~35 call sites — and until this
 * landed it wrote nothing anywhere: two fire-and-forget, independently-swallowed pushes (mobile
 * APNs/FCM, desktop SSE), both silently no-op-safe (no paired device / no open webview). After a
 * silent halt, "was the human ever told?" was unanswerable, even to the agent that raised it.
 *
 * One row per call, written UNCONDITIONALLY before either channel is attempted, then updated
 * with each channel's outcome — turns the epistemic gap into a query. Best-effort: a failure to
 * write/update this audit trail is logged and swallowed, exactly like the two delivery channels
 * themselves — the audit log must never become a new way for notifyAttention to throw.
 */
import { withWorkspace } from '@papercusp/db-org';

export interface AttentionNotificationRecordInput {
  workspaceId: string;
  harnessSlug?: string;
  kind: string;
  title: string;
  body: string;
  importance?: string;
  data?: Record<string, unknown>;
}

export interface AttentionNotificationChannelOutcome {
  attempted: boolean;
  succeeded?: boolean;
  error?: string;
}

/** Insert the intent row BEFORE either channel is attempted. Returns the row id, or null on a
 *  (logged, swallowed) write failure — callers must still attempt delivery either way. */
export async function recordAttentionNotifyIntent(
  input: AttentionNotificationRecordInput,
): Promise<number | null> {
  try {
    return await withWorkspace(input.workspaceId, async (tx) => {
      const rows = await tx<{ id: number }[]>`
        INSERT INTO harness_shared.attention_notifications
          (workspace_id, harness_slug, kind, title, body, importance, data)
        VALUES (
          ${input.workspaceId}, ${input.harnessSlug ?? null}, ${input.kind},
          ${input.title}, ${input.body}, ${input.importance ?? null},
          ${input.data ? JSON.stringify(input.data) : null}
        )
        RETURNING id
      `;
      return rows[0]?.id ?? null;
    });
  } catch (e) {
    console.warn('[attention-notify-store] failed to record intent:', (e as Error)?.message ?? e);
    return null;
  }
}

/** Stamp one channel's outcome onto an already-recorded row. No-op (logged) if `id` is null —
 *  the intent insert itself failed, so there is nothing to update. */
export async function recordAttentionNotifyOutcome(
  id: number | null,
  workspaceId: string,
  channel: 'mobile' | 'desktop',
  outcome: AttentionNotificationChannelOutcome,
): Promise<void> {
  if (id == null) return;
  try {
    await withWorkspace(workspaceId, async (tx) => {
      if (channel === 'mobile') {
        await tx`
          UPDATE harness_shared.attention_notifications
          SET mobile_attempted = ${outcome.attempted},
              mobile_succeeded = ${outcome.succeeded ?? null},
              mobile_error = ${outcome.error ?? null},
              mobile_completed_at = now()
          WHERE id = ${id}
        `;
      } else {
        await tx`
          UPDATE harness_shared.attention_notifications
          SET desktop_attempted = ${outcome.attempted},
              desktop_succeeded = ${outcome.succeeded ?? null},
              desktop_error = ${outcome.error ?? null},
              desktop_completed_at = now()
          WHERE id = ${id}
        `;
      }
    });
  } catch (e) {
    console.warn(
      `[attention-notify-store] failed to record ${channel} outcome for id=${id}:`,
      (e as Error)?.message ?? e,
    );
  }
}
