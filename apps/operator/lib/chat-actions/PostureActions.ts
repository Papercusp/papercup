/**
 * Posture actions — Autonomy (radio: manual/auto/cold-auto) and Overlays
 * (checkbox: ideate/drain/grade) as TWO ChatActions writing
 * mode:set { ownerDirected: true } (gui-chat-session-controls-2026-07-25 P-004).
 *
 * Labels/hints come from the mode registry
 * (packages/operator-core/lib/modes/registry — the SAME source mode:set /
 * mode:get / the HUD chips already read) so no new copy drifts from it.
 *
 * Both actions post through the admin proxy route
 * (packages/operator-core/lib/endpoint-route/routes/admin/mode.ts, P-003) —
 * the browser has no bearer token, so the route re-dispatches into mode:set
 * in-process with a verified owner-authority identity
 * (ident.ownerId === ADMIN_COORD_UI_OWNER), which is what lets this write
 * carry ownerDirected:true and arm the D-003 sticky guard.
 *
 * No live "what's currently set" read: both `run` implementations are
 * reconciling (they set every option's enabled state explicitly — the
 * unchecked/unselected ones included), so posting is safe and idempotent
 * regardless of prior state, and mode:set { enabled:false } is a no-op on
 * whichever mode wasn't already active. This avoids needing a mode:get round
 * trip just to pre-populate the card.
 */
import { z } from 'zod';
import { modeById, modeChipLabel } from '@papercusp/operator-core/lib/modes/registry';
import { registerChatAction } from './registry';
import type { ChatActionContext } from './types';

const AUTONOMY_IDS = ['manual', 'auto', 'cold-auto'] as const;
type AutonomyId = (typeof AUTONOMY_IDS)[number];

const OVERLAY_IDS = ['ideate', 'drain', 'grade'] as const;
type OverlayId = (typeof OVERLAY_IDS)[number];

/** POST one mode:set write through the admin proxy route (P-003). Exported for tests. */
export async function postModeSet(agent: string, mode: string, enabled: boolean, reason: string): Promise<void> {
  const r = await fetch('/api/admin/mode/set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, enabled, reason, agent, ownerDirected: true }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`mode:set(${mode}) → ${r.status}: ${text.slice(0, 200)}`);
  let parsed: { ok?: boolean; error?: string; stickyConflict?: boolean } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* tolerate a non-JSON 200 — treated as success */
  }
  if (parsed.ok === false) {
    throw new Error(
      parsed.stickyConflict
        ? `mode:set(${mode}) refused — an owner-directed incumbent is already set; your change was delivered as a request instead`
        : `mode:set(${mode}) → ${parsed.error ?? 'unknown error'}`,
    );
  }
}

function ownerId(ctx: ChatActionContext): string {
  return ctx.sessionOwnerId;
}

registerChatAction({
  id: 'posture-autonomy',
  label: 'Autonomy',
  group: 'posture',
  available: (ctx) => Boolean(ctx.sessionOwnerId),
  params: async () => ({
    prompt: 'Set autonomy posture',
    dataSchema: z.object({ picks: z.tuple([z.enum(AUTONOMY_IDS)]) }),
    presentation: {
      kind: 'radio',
      options: AUTONOMY_IDS.map((id) => ({
        id,
        label: id === 'manual' ? 'Manual' : (modeById(id)?.title ?? modeChipLabel(id)),
        hint:
          id === 'manual'
            ? 'Confirm-before-acting posture — no standing autonomy mode'
            : modeById(id)?.oneLiner,
      })),
    },
    allowDecline: true,
  }),
  run: async (ctx, value) => {
    const [choice] = (value as { picks: [AutonomyId] }).picks;
    const reason = 'owner set autonomy posture from the chat action bar';
    const agent = ownerId(ctx);
    if (choice === 'manual') {
      // Clear both autonomy-axis modes — enabled:false is a no-op on
      // whichever wasn't set, so this is safe without a prior-state read.
      await Promise.all([
        postModeSet(agent, 'auto', false, reason),
        postModeSet(agent, 'cold-auto', false, reason),
      ]);
      return;
    }
    await postModeSet(agent, choice, true, reason);
  },
});

registerChatAction({
  id: 'posture-overlays',
  label: 'Overlays',
  group: 'posture',
  available: (ctx) => Boolean(ctx.sessionOwnerId),
  params: async () => ({
    prompt: 'Set overlay modes (stackable — pick any number)',
    dataSchema: z.object({ picks: z.array(z.enum(OVERLAY_IDS)) }),
    presentation: {
      kind: 'checkbox',
      options: OVERLAY_IDS.map((id) => ({
        id,
        label: modeById(id)?.title ?? modeChipLabel(id),
        hint: modeById(id)?.oneLiner,
      })),
    },
    allowDecline: true,
  }),
  run: async (ctx, value) => {
    const picks = new Set((value as { picks: OverlayId[] }).picks);
    const reason = 'owner set overlay modes from the chat action bar';
    const agent = ownerId(ctx);
    // Reconcile all three explicitly (checked → enabled, unchecked →
    // disabled) rather than diffing against a fetched prior state.
    await Promise.all(OVERLAY_IDS.map((id) => postModeSet(agent, id, picks.has(id), reason)));
  },
});
