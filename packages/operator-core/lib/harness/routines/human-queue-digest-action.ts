/**
 * `system:improvement-human-digest` — the weekly owner drain ritual over the
 * human review queue (self-improvement-consume-edges-2026-06-12 P-022 / B-08,
 * adopting Scout's own EI-340/EI-352 proposals).
 *
 * Once a week, send the owner the TOP-5 human-lane items ordered by BLOCKING
 * IMPACT (blocking-impact.ts: `blocks` edges, inbound references, open
 * re-captures, watchdog persistence, severity × log staleness), each with its
 * "why this ranks here" reasons — so scarce owner attention always lands on
 * the highest-leverage decision first, and the queue gets a drain cadence
 * instead of compounding silently (the 06-12 audit's "flat human queue").
 *
 * NOT a revival of the removed `improvement-digest` push (operator-learning-tab
 * D-001 killed a dead-end headline notification): this one is (a) weekly, not
 * per-tick; (b) a ranked, reasoned top-5, not a count; (c) no longer a dead
 * end — the Learning tab exists to open. Read-only: it changes no state, so
 * the routine seeds ACTIVE (seed-human-digest-routine.ts).
 *
 * Delivery rides BOTH existing rails, each best-effort (a delivery failure
 * never fails the tick): the persistent coord inbox (`to: ['human']`) and
 * `notifyAttention` (desktop-native + mobile push).
 *
 * Config (routine `trigger_config`, optional):
 *   - `top_n` — how many items the digest leads with (default 5).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { readImprovementItems } from '../improvements/read-items';
import { buildDigest } from '../improvements/digest';
import { readOwnerFullAutonomyGrant } from '../improvements/full-autonomy-grant';
import type { ImpactRankedItem } from '../improvements/blocking-impact';
import { applyHumanQueueRanking } from '../../queue-ranker/human-queue';

/** Coord identity for the digest message (mirrors token-report / git-sync). */
const HUMAN_DIGEST_IDENTITY: AgentIdentity = {
  ownerId: 'system:improvement-human-digest',
  ownerLabel: 'human-queue-digest',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

const DEFAULT_TOP_N = 5;
const TITLE_MAX = 110;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Compose the digest message. Pure. Returns null for an empty queue (no spam). */
export function composeHumanQueueDigest(
  humanQueue: readonly ImpactRankedItem[],
  opts: { topN?: number } = {},
): { summary: string; body: string } | null {
  if (humanQueue.length === 0) return null;
  const topN = Math.max(1, opts.topN ?? DEFAULT_TOP_N);
  const top = humanQueue.slice(0, topN);

  const lines = top.map((it, i) => {
    const sev = it.severity ?? 'minor';
    const age = `${Math.round(it.ageDays)}d`;
    const why = it.impact.reasons.length ? `\n   why: ${it.impact.reasons.join('; ')}` : '';
    return `${i + 1}. **${it.id}** — ${truncate(it.title, TITLE_MAX)} _[${sev} · ${age} · impact ${it.impact.score}]_${why}`;
  });

  const rest = humanQueue.length - top.length;
  const body = [
    `Your review queue, ordered by **blocking impact** — what is actually waiting on each item (downstream \`blocks\` edges, references, open re-captures, watchdog persistence), not just severity or age. The top card is the one thing to decide now.`,
    lines.join('\n'),
    rest > 0
      ? `…plus ${rest} more. Full ranked list: Learning tab → Improvements → "Needs review" lane (same order).`
      : `That's the whole queue. Full detail: Learning tab → Improvements → "Needs review" lane.`,
  ].join('\n\n');

  const summary =
    `Weekly review-queue digest: ${humanQueue.length} item(s) await your decision — ` +
    `top blocker: ${top[0].id} (impact ${top[0].impact.score}${top[0].impact.reasons[0] ? ` — ${top[0].impact.reasons[0]}` : ''}).`;

  return { summary, body };
}

registerSystemAction('improvement-human-digest', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const topN =
    Number.isFinite(Number(cfg.top_n)) && Number(cfg.top_n) > 0 ? Number(cfg.top_n) : DEFAULT_TOP_N;

  const items = await readImprovementItems({ state: 'open' });
  // The OWNER FULL-AUTONOMY grant (Phase 2): the weekly human-queue digest must not list a
  // protected-surface kind=bug as "awaiting your decision" while the loop auto-implements it.
  const ownerFullAutonomy = await readOwnerFullAutonomyGrant(ctx.workspaceId);
  const digest = await applyHumanQueueRanking(buildDigest(items, { ownerFullAutonomy }), { candidates: items });
  const composed = composeHumanQueueDigest(digest.humanQueue, { topN });
  if (!composed) {
    console.log('[human-queue-digest] human queue empty — nothing to send');
    return;
  }

  // Persistent inbox rail — the digest the owner can read later.
  try {
    await sendMessage(HUMAN_DIGEST_IDENTITY, { to: ['human'], summary: composed.summary, body: composed.body });
  } catch (e) {
    console.warn('[human-queue-digest] inbox send failed:', e instanceof Error ? e.message : e);
  }

  // Attention rail — desktop-native + mobile push, so the weekly ritual is seen.
  try {
    const { notifyAttention } = await import('../../attention-notify');
    await notifyAttention({
      kind: 'needs-human',
      title: 'Weekly review-queue digest',
      body: composed.summary,
      importance: 'normal',
      workspaceId: ctx.workspaceId,
      data: { queue: digest.humanQueue.length, top: digest.humanQueue[0]?.id ?? null },
    });
  } catch (e) {
    console.warn('[human-queue-digest] attention notify failed:', e instanceof Error ? e.message : e);
  }

  console.log(`[human-queue-digest] ${composed.summary}`);
});
