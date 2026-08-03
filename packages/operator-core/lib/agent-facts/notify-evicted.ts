/**
 * Tell the OWNER of a fact that the per-scope cap destroyed it (EI-19442566203468589).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * `assertFact` evicts the lowest-ranked incumbent when a scope is at its cap.
 * WI-7298 made that loud — **to the writer**, in the assert receipt. That is the
 * wrong audience, and it is the whole bug: the writer already knows they wrote.
 * The person who needs to know is the fact's AUTHOR, and they are told nothing.
 *
 * Their fact is documented as folded verbatim into every future orient UNTIL
 * RETRACTED. After an eviction it simply stops appearing. Nothing errors.
 * Nothing in their orient says why. The failure mode of a MISSING fact is
 * silence — it does not break anything, it just quietly stops informing
 * decisions, which is indistinguishable from the fact never having mattered.
 *
 * Measured 2026-08-03: `scope:harness/papercusp` was THRASHING at its cap, not
 * occasionally full — two agents evicted each other's facts within 12 minutes,
 * one of them a `confidence:'verified'` fact with ~29 days of TTL left. Both
 * evictions were discovered only because the evicting agents happened to notice
 * the receipt and messaged the owner BY HAND. This module is that hand-message,
 * made unconditional.
 *
 * ── WHY IT LIVES AT THE STORE, NOT THE TOOL ────────────────────────────────
 * `facts:assert` is only ONE of six `assertFact` callers. The others are
 * automated writers — the release-readiness routine, the gate canary sweep,
 * deprecate-learnings, bootstrap-su — and they evict exactly like anyone else.
 * Notifying from the tool layer would leave every ROUTINE-caused eviction
 * silent, which is the same defect with a smaller blast radius.
 *
 * ── DELIBERATELY NOT CATEGORISED ───────────────────────────────────────────
 * This message intentionally carries NO `category`. A categorised message is
 * treated as an ambient system broadcast and is DEFAULT-EXCLUDED from
 * `coord:inbox` — so tagging this (the obvious tidy-up) would deliver the
 * notice into a channel the owner does not read by default, silently
 * re-creating the exact invisibility this exists to remove. If you are tempted
 * to add one, that is the trap.
 */
import type { FactEviction } from './store';

/** Best-effort: a failed notification must never fail the write that caused it. */
export interface NotifyEvictedArgs {
  evicted: readonly FactEviction[];
  /** The agent whose assert displaced these facts. */
  writerOwnerId: string;
  scope: string;
  scopeRef?: string | null;
}

/** Owners to notify, grouped — one message each, never one per evicted key. */
export function groupVictimsByOwner(
  evicted: readonly FactEviction[],
  writerOwnerId: string,
): Map<string, FactEviction[]> {
  const byOwner = new Map<string, FactEviction[]>();
  for (const e of evicted) {
    const owner = (e.createdBy ?? '').trim();
    if (!owner) continue;
    // Self-eviction needs no message: the writer already has the receipt, and
    // WI-7292 separately made a write stop evicting the row it just inserted.
    // Messaging yourself is pure noise in an inbox that is read under pressure.
    if (owner === writerOwnerId) continue;
    const list = byOwner.get(owner);
    if (list) list.push(e);
    else byOwner.set(owner, [e]);
  }
  return byOwner;
}

/** The body an owner receives. Exported so a test pins the wording's substance. */
export function renderEvictionNotice(
  victims: readonly FactEviction[],
  args: { writerOwnerId: string; scope: string; scopeRef?: string | null },
): { summary: string; body: string } {
  const scopeLabel = args.scopeRef ? `${args.scope}/${args.scopeRef}` : args.scope;
  const n = victims.length;
  const keys = victims.map((v) => v.key);
  const summary =
    `Your standing fact${n === 1 ? '' : 's'} ${keys.map((k) => `\`${k}\``).join(', ')} ` +
    `${n === 1 ? 'was' : 'were'} EVICTED by the ${scopeLabel} fact cap — not expired, not retracted by you.`;

  const lines = victims.map((v) => {
    const conf = v.confidence ? `confidence:${v.confidence}` : 'confidence:unset';
    return `  • \`${v.key}\` (${conf}, TTL ran to ${v.expiresAt})`;
  });

  const body =
    `The per-scope fact cap on \`${scopeLabel}\` destroyed ${n === 1 ? 'a fact' : 'facts'} you asserted:\n` +
    `${lines.join('\n')}\n\n` +
    `This was NOT an expiry and NOT a retraction by you. My assert into the same scope ` +
    `displaced ${n === 1 ? 'it' : 'them'} because the scope was at its cap.\n\n` +
    `WHY YOU ARE BEING TOLD: a fact is documented as folded into every future orient until ` +
    `retracted, so without this message ${n === 1 ? 'it' : 'they'} would simply stop appearing ` +
    `in your folds with nothing anywhere saying why. A missing fact does not error — it just ` +
    `quietly stops informing your decisions.\n\n` +
    `WHAT TO DO: if ${n === 1 ? 'it' : 'any of them'} still matters, re-assert it. Note that ` +
    `re-asserting will itself evict the next-lowest-ranked fact while the scope stays full, ` +
    `so prefer re-asserting only what is still load-bearing.\n\n` +
    `HOW VICTIMS ARE CHOSEN (so this is predictable rather than mysterious): the cap keeps the ` +
    `most valuable and drops the tail, ranked by confidence first ('verified' survives longest, ` +
    `'suspected' dies first), then by declared TTL (a longer TTL survives), then write-recency. ` +
    `A fact can still be evicted despite a long TTL if enough higher-ranked facts fill the scope.`;

  return { summary, body };
}

/**
 * Notify each evicted fact's author. NEVER throws and never rejects — an
 * eviction notice failing must not turn a successful `facts:assert` into an
 * error. Returns the owners actually messaged (for tests/telemetry).
 */
export async function notifyEvictedFactOwners(args: NotifyEvictedArgs): Promise<string[]> {
  try {
    const byOwner = groupVictimsByOwner(args.evicted, args.writerOwnerId);
    if (byOwner.size === 0) return [];

    // Lazy import: the store is a low-level module and the coord message seam
    // pulls in a large graph. Importing it statically here would couple every
    // fact write to the coordination plane's module graph.
    const { sendMessage } = await import('../agent-tools/coordination/messages');

    const notified: string[] = [];
    for (const [owner, victims] of byOwner) {
      const { summary, body } = renderEvictionNotice(victims, args);
      try {
        await sendMessage(
          {
            ownerId: args.writerOwnerId,
            ownerLabel: args.writerOwnerId,
            source: 'static-client',
            workspaceId: null,
            userId: null,
          } as Parameters<typeof sendMessage>[0],
          {
            to: [owner],
            summary,
            body,
            // NO `category` — see the module header. A categorised message is
            // default-excluded from coord:inbox as ambient.
            extra: { auto: true, factEviction: { keys: victims.map((v) => v.key), scope: args.scope } },
          },
        );
        notified.push(owner);
      } catch {
        // One owner's delivery failing must not block the others.
      }
    }
    return notified;
  } catch {
    return [];
  }
}
