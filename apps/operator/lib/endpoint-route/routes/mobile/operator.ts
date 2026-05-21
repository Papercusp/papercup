/**
 * Mobile operator-surface routes — Phase E4 batch M3
 * (endpoint-unification-2026-05-21). Ported off `_hono/mobile.ts`.
 *
 *   GET    /mobile/notifications/recent             mobile JWT
 *   GET    /mobile/actions/recent                   mobile JWT
 *   GET    /mobile/operator/pause                   mobile JWT
 *   POST   /mobile/operator/pause                   mobile JWT
 *   DELETE /mobile/operator/pause                   mobile JWT
 *   GET    /mobile/operator/cards                   mobile JWT
 *   POST   /mobile/operator/cards/:id/dispatch      mobile JWT
 *   POST   /mobile/operator/cards/:id/dismiss       mobile JWT
 *   GET    /mobile/operator/standing-candidates     mobile JWT
 *   POST   /mobile/operator/standing-candidates/decide  mobile JWT
 */
import { z } from 'zod';
import { defineRoute } from '../../define-route';
import { MOBILE_AUTH, mobilePrincipal } from './_shared';
import { recentToasts, recentAuditEntries } from '@/lib/mobile-feeds';
import {
  listPendingCards,
  dispatchCard,
  dismissCard,
  setPaused,
  setResumed,
  getPauseInfo,
} from '@/lib/mobile-operator-actions';
import { readCandidates, refreshCandidates } from '@/lib/operator-standing-candidates';
import { appendPreferenceEntry } from '@/lib/operator-preferences';

/** Clamp a `?limit=` query param to [1, 200], default 50. */
function limitParam(req: Request): number {
  const raw = new URL(req.url).searchParams.get('limit') ?? '50';
  return Math.min(Number(raw) || 50, 200);
}

/* ─── Activity feeds ─────────────────────────────────────────────────── */

const notificationsRecent = defineRoute({
  method: 'GET',
  path: '/mobile/notifications/recent',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(req, ctx) {
    const rows = await recentToasts(mobilePrincipal(ctx).workspaceId, limitParam(req));
    return Response.json({ toasts: rows });
  },
});

const actionsRecent = defineRoute({
  method: 'GET',
  path: '/mobile/actions/recent',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(req, ctx) {
    const rows = await recentAuditEntries(mobilePrincipal(ctx).workspaceId, limitParam(req));
    return Response.json({ entries: rows });
  },
});

/* ─── Global pause flag ──────────────────────────────────────────────── */

const pauseGet = defineRoute({
  method: 'GET',
  path: '/mobile/operator/pause',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler() {
    return Response.json(await getPauseInfo());
  },
});

const pauseSet = defineRoute({
  method: 'POST',
  path: '/mobile/operator/pause',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(_req, ctx) {
    await setPaused(mobilePrincipal(ctx).label ?? 'mobile');
    return Response.json(await getPauseInfo());
  },
});

const pauseClear = defineRoute({
  method: 'DELETE',
  path: '/mobile/operator/pause',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler() {
    await setResumed();
    return Response.json(await getPauseInfo());
  },
});

/* ─── Operator cards ─────────────────────────────────────────────────── */

const cardsList = defineRoute({
  method: 'GET',
  path: '/mobile/operator/cards',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler() {
    return Response.json({ cards: await listPendingCards() });
  },
});

const cardDispatch = defineRoute({
  method: 'POST',
  path: '/mobile/operator/cards/:id/dispatch',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(_req, ctx) {
    const cards = await listPendingCards();
    const card = cards.find((x) => x.id === ctx.params.id);
    if (!card) return Response.json({ ok: false, error: 'card_not_found' }, { status: 404 });
    const result = await dispatchCard(card);
    return Response.json({ ok: true, message: result });
  },
});

const cardDismiss = defineRoute({
  method: 'POST',
  path: '/mobile/operator/cards/:id/dismiss',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(_req, ctx) {
    const cards = await listPendingCards();
    const card = cards.find((x) => x.id === ctx.params.id);
    if (!card) return Response.json({ ok: false, error: 'card_not_found' }, { status: 404 });
    const result = await dismissCard(card);
    return Response.json({ ok: true, message: result });
  },
});

/* ─── Standing-approval candidates ───────────────────────────────────── */

const standingCandidatesList = defineRoute({
  method: 'GET',
  path: '/mobile/operator/standing-candidates',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler() {
    const candidates = await refreshCandidates().catch(() => readCandidates());
    return Response.json({ candidates });
  },
});

const standingCandidatesDecide = defineRoute({
  method: 'POST',
  path: '/mobile/operator/standing-candidates/decide',
  auth: MOBILE_AUTH,
  mobile: true,
  input: z.object({
    capability: z.string().min(1),
    targetHarness: z.string().min(1),
    decision: z.enum(['approve', 'dismiss']),
  }),
  async handler(_req, ctx) {
    const { capability, targetHarness, decision } = ctx.input;
    if (decision === 'approve') {
      const today = new Date().toISOString().slice(0, 10);
      const entry = `- [OPERATOR-PROPOSED-USER-CONFIRMED-${today}] [STANDING-APPROVE]\n  capability=${capability}, target=${targetHarness}\n  pattern: ≥3 silent dispatches in 24h\n  user confirmed: ${new Date().toISOString()}`;
      await appendPreferenceEntry(entry);
    }
    await refreshCandidates().catch(() => {});
    return Response.json({ ok: true });
  },
});

export default [
  notificationsRecent,
  actionsRecent,
  pauseGet,
  pauseSet,
  pauseClear,
  cardsList,
  cardDispatch,
  cardDismiss,
  standingCandidatesList,
  standingCandidatesDecide,
];
