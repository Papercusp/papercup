/**
 * ref-hydrate-resolve.ts — the IO half of ./ref-hydrate (coord-authority-
 * hardening-2026-07-11 P-001): resolve typed refs against their stores and
 * produce render-ready hydrations.
 *
 * Fail-soft BY CONTRACT: a hydration is delivery decoration — a lookup miss,
 * a store error, or a missing resolver must NEVER fail or block the send /
 * delivery it decorates. Every failure degrades to `{ ok:false, error }`,
 * which renders as an explicit "unresolved" line (never silently dropped, so
 * a dangling ref is visible rather than papered over).
 *
 * Resolvers are INJECTABLE: consumers that own a store this module shouldn't
 * import (announced-gates in P-006, the session store's owner-turn read in
 * P-004) install theirs via `resolvers`; the defaults cover the two stores
 * with clean existing getters (coord messages, work-items). Injection also
 * keeps the unit tests DB-free.
 */

import type { CoordEnvelope } from './envelope';
import { getMessageById } from './messages';
import { getWorkItem } from '../../work-items';
import { findAnnouncementsForKey } from '../../events/await/store';
import { getPlanRow, planItemsForRow } from '../plans/source';
import { resolveEffectiveStatusForItems } from '../plans/effective-status';
import {
  applyRefBudget,
  BODY_REF_CHECKPOINT_TAIL_CHARS,
  canonicalRefKey,
  clampSnippet,
  clampSnippetTail,
  DEFAULT_REF_BUDGET,
  GATE_REFS_MAX,
  type GateRefStamp,
  type HydratableRef,
  type HydratedRef,
  type RefHydrationBudget,
} from './ref-hydrate';

/** One resolver: typed ref → { label, snippet } | null (null = not found). */
export type RefResolver = (
  ref: HydratableRef,
  budget: RefHydrationBudget,
) => Promise<{ label: string; snippet: string } | null>;

export type RefResolvers = Partial<Record<HydratableRef['kind'], RefResolver>>;

/** Compact agent handle for labels — mirrors the [coord+N] short-handle form. */
function shortHandle(ownerId: string): string {
  return (ownerId ?? '').replace(/^su-/, '').slice(0, 5) || ownerId;
}

/** Compact UTC stamp for labels: `2026-07-11T09:01Z`. */
function shortTs(iso: string): string {
  return typeof iso === 'string' && iso.length >= 16 ? `${iso.slice(0, 16)}Z` : iso;
}

function msgLabel(env: CoordEnvelope): string {
  const to = env.audience?.length ? env.audience.join(',') : env.to.join(',');
  return `msg ${env.msg_id} (${shortHandle(env.from)} → ${to}, ${shortTs(env.ts)})`;
}

const defaultMsgResolver: RefResolver = async (ref, budget) => {
  if (ref.kind !== 'msg') return null;
  const env = await getMessageById(ref.id);
  if (!env) return null;
  const content = [env.summary, env.body].filter(Boolean).join(' — ');
  return { label: msgLabel(env), snippet: clampSnippet(content, budget.snippetChars) };
};

const defaultWorkItemResolver: RefResolver = async (ref, budget) => {
  if (ref.kind !== 'work-item') return null;
  const wi = await getWorkItem(ref.id);
  if (!wi) return null;
  const assignee = wi.assignee ? ` @${shortHandle(wi.assignee)}` : '';
  return {
    label: `${wi.id} [${wi.kind}/${wi.state}${assignee}]`,
    snippet: clampSnippet([wi.title, wi.summary].filter(Boolean).join(' — '), budget.snippetChars),
  };
};

const DEFAULT_RESOLVERS: RefResolvers = {
  msg: defaultMsgResolver,
  'work-item': defaultWorkItemResolver,
  // plan-item / gate / owner-turn: installed by their consuming plan items
  // (P-006 gateRefs, P-004 owner-turn) via the `resolvers` arg — a ref of a
  // kind with no installed resolver degrades to `resolver_not_installed`.
};

/**
 * P-008 delivery resolver for AUTO-DETECTED work-item mentions: the default
 * label (id [kind/state @assignee]) + title snippet, EXTENDED with the item's
 * checkpoint TAIL (`⌁ …<end of checkpoint>`) — the freshest "where is it
 * actually" a receiver otherwise re-fetches or half-remembers. The checkpoint
 * read is a DYNAMIC import: this module's STATIC chain must not grow (suites
 * that partial-mock `@papercusp/flags/server` — send.test — import it; a new
 * static store chain here re-arms the flags/server partial-mock trap). The
 * tail is decoration on decoration: any failure just omits it. The combined
 * snippet stays within `budget.snippetChars` (the tail eats into the title's
 * share, never past the cap).
 */
export const bodyRefWorkItemResolver: RefResolver = async (ref, budget) => {
  if (ref.kind !== 'work-item') return null;
  const wi = await getWorkItem(ref.id);
  if (!wi) return null;
  const assignee = wi.assignee ? ` @${shortHandle(wi.assignee)}` : '';
  let tail = '';
  try {
    const [{ getWorkItemCheckpoint }, { activeWorkspaceId }] = await Promise.all([
      import('../../work-item-checkpoint'),
      import('../../workspace-registry'),
    ]);
    const cp = await getWorkItemCheckpoint({
      workItemId: wi.id,
      harness: wi.harness,
      workspaceId: activeWorkspaceId(),
    });
    if (cp) tail = ` ⌁ ${clampSnippetTail(cp, BODY_REF_CHECKPOINT_TAIL_CHARS)}`;
  } catch {
    /* fail-soft: no tail */
  }
  const head = clampSnippet(
    [wi.title, wi.summary].filter(Boolean).join(' — '),
    Math.max(0, budget.snippetChars - tail.length),
  );
  return { label: `${wi.id} [${wi.kind}/${wi.state}${assignee}]`, snippet: `${head}${tail}` };
};

/**
 * Plan-item body resolver factory (coordination/ref-hydrate.ts consumer:
 * coord:dispatch / coord:handoff, WI-4165 — "hydrate assigned plan-item
 * bodies into coord:dispatch / handoff deliveries"): resolves a
 * `{kind:'plan-item', slug, item}` ref into that item's own text +
 * effectiveStatus off the PG-canonical plan row (the SAME resolution
 * plans:get-item / plans:items / plans:set-status agree on — EI-356).
 *
 * NOT part of DEFAULT_RESOLVERS: unlike msg/work-item (global stores), a plan
 * item's harness scope varies per call site (a dispatch/handoff's own
 * `harness` arg, defaulting to the plan's own harness when omitted) — each
 * consumer binds its own resolver via this factory and installs it through
 * `resolvers`, the same injection contract P-006 (gate) and P-004
 * (owner-turn) already use for consumer-owned stores.
 */
export function makePlanItemResolver(harness?: string): RefResolver {
  return async (ref, budget) => {
    if (ref.kind !== 'plan-item') return null;
    const row = await getPlanRow(ref.slug, harness ? { harnessSlug: harness } : {});
    if (!row) return null;
    const { items } = resolveEffectiveStatusForItems(planItemsForRow(row));
    const item = items.find((i) => i.id === ref.item);
    if (!item) return null;
    return {
      label: `plan:${ref.slug}#${ref.item} [${item.effectiveStatus}]`,
      snippet: clampSnippet(item.text, budget.snippetChars),
    };
  };
}

/**
 * Resolve `refs` (budget-deduped, first-N) into render-ready hydrations, in
 * parallel, each fail-soft. Order of the returned list follows the budgeted
 * input order.
 */
/**
 * P-006: resolve a sender's gateRefs (announced-gate event keys) into
 * send-time-verified stamps — checked against the announced-gates store the
 * receiver's `events:await` will also consult. De-duped + capped; each probe
 * fail-softs to `unknown` (a store hiccup must never block the send). The KEY
 * always travels verbatim — verification decorates it, never rewrites it.
 */
export async function resolveGateRefStamps(keys: string[]): Promise<GateRefStamp[]> {
  const uniq = [...new Set(keys.map((k) => (k ?? '').trim()).filter(Boolean))].slice(
    0,
    GATE_REFS_MAX,
  );
  return Promise.all(
    uniq.map(async (key): Promise<GateRefStamp> => {
      try {
        const anns = await findAnnouncementsForKey(key);
        if (anns.some((a) => a.firedAt && a.firedReason === 'event')) return { key, status: 'fired' };
        if (anns.some((a) => !a.firedAt)) return { key, status: 'declared' };
        return { key, status: 'undeclared' };
      } catch {
        return { key, status: 'unknown' };
      }
    }),
  );
}

export async function hydrateRefs(
  refs: HydratableRef[],
  opts: { budget?: RefHydrationBudget; resolvers?: RefResolvers } = {},
): Promise<HydratedRef[]> {
  const budget = opts.budget ?? DEFAULT_REF_BUDGET;
  const resolvers: RefResolvers = { ...DEFAULT_RESOLVERS, ...opts.resolvers };
  const survivors = applyRefBudget(refs, budget);
  return Promise.all(
    survivors.map(async (ref): Promise<HydratedRef> => {
      const resolver = resolvers[ref.kind];
      if (!resolver) {
        return {
          ref,
          ok: false,
          label: canonicalRefKey(ref),
          snippet: '',
          error: 'resolver_not_installed',
        };
      }
      try {
        const hit = await resolver(ref, budget);
        if (!hit) {
          return { ref, ok: false, label: canonicalRefKey(ref), snippet: '', error: 'not_found' };
        }
        return { ref, ok: true, label: hit.label, snippet: hit.snippet };
      } catch {
        return { ref, ok: false, label: canonicalRefKey(ref), snippet: '', error: 'resolve_error' };
      }
    }),
  );
}
