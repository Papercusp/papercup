/**
 * ref-hydrate.ts — the shared deref-at-delivery vocabulary: parse, budget, and
 * render TYPED REFS so content travels by REFERENCE and the platform expands it
 * verbatim at the delivery/injection boundary (coord-authority-hardening-2026-07-11
 * P-001, from the EI-9501 post-incident audit).
 *
 * The failure class this kills: an agent RE-TYPES content that already exists
 * durably under an id — a relayed owner directive (EI-9501: paraphrased +
 * mis-scoped hive-wide), a hand-typed gate key (waiter strands forever), a
 * work-item title recalled stale, a reply whose question the asker compacted
 * away. Deref-at-delivery means the sender passes the id, the platform inlines
 * a bounded VERBATIM snippet at delivery, and the receiver pays zero fetch
 * round-trips. Consumers: relayOf (P-004), related_msg_id (P-005), gateRefs
 * (P-006), facts sourceRef (P-007), body auto-refs (P-008), dispatch/handoff
 * (WI-4165, deferred).
 *
 * Budget discipline (D-004): a hydration is a COMPACT snippet + the retained id
 * (full fetch stays one call away), capped per message, and NEVER recursive —
 * a hydrated quote's own refs do not expand.
 *
 * Pure + import-free (like ./cue-authority): the IO half (message / work-item /
 * gate lookups) lives in ./ref-hydrate-resolve so coord-schema (the injection
 * renderer) can import the parse/render helpers WITHOUT pulling the DB /
 * agent-mcp graph into its dependency tree.
 */

/** A typed, platform-resolvable reference. */
export type HydratableRef =
  /** A coord message by msg_id (`msg:<id>`). */
  | { kind: 'msg'; id: string }
  /** A work-item by id — WI-/EI-/F- families (`WI-123`, `wi:WI-123`). */
  | { kind: 'work-item'; id: string }
  /** A plan item (`plan:<slug>#P-001`). */
  | { kind: 'plan-item'; slug: string; item: string }
  /** An announced event gate by exact key (`gate:<key>`). */
  | { kind: 'gate'; key: string }
  /** The calling session's current human turn (`owner-turn` sentinel — the
   *  H2 Tier-2 origin; a TUI turn has NO coord msg_id, so it is resolved
   *  server-side from the session store, never referenced by id). */
  | { kind: 'owner-turn' };

export interface RefHydrationBudget {
  /** Max characters of verbatim snippet per hydrated ref. */
  snippetChars: number;
  /** Max refs hydrated per message — beyond this, refs pass through unhydrated. */
  maxRefs: number;
}

/** D-004: ~200 chars/ref, ≤3 refs/message, never recursive. */
export const DEFAULT_REF_BUDGET: RefHydrationBudget = { snippetChars: 200, maxRefs: 3 };

/** One resolved (or failed-soft) hydration, ready to render. */
export interface HydratedRef {
  ref: HydratableRef;
  ok: boolean;
  /** Short structured label — WHO/WHAT/WHEN, never the content itself. */
  label: string;
  /** Bounded VERBATIM snippet (single-line, clamped); '' when !ok. */
  snippet: string;
  /** Failure tag when !ok: 'not_found' | 'resolver_not_installed' | 'resolve_error'. */
  error?: string;
}

const WORK_ITEM_ID = /^(?:wi:)?((?:WI|EI|F)-\d+)$/i;
const PLAN_ITEM = /^plan:([a-z0-9][a-z0-9-]*)#(P-\d{3,})$/i;
const MSG_REF = /^msg:(\S+)$/i;
const GATE_REF = /^gate:(\S+)$/;

/**
 * Parse one explicit ref token into a typed ref. Returns null for anything
 * unrecognized — callers must treat null as "not a ref", never an error.
 */
export function parseRefToken(token: string): HydratableRef | null {
  const t = (token ?? '').trim();
  if (!t) return null;
  if (t === 'owner-turn') return { kind: 'owner-turn' };
  const msg = MSG_REF.exec(t);
  if (msg) return { kind: 'msg', id: msg[1] };
  const wi = WORK_ITEM_ID.exec(t);
  if (wi) return { kind: 'work-item', id: wi[1].toUpperCase() };
  const pi = PLAN_ITEM.exec(t);
  if (pi) return { kind: 'plan-item', slug: pi[1].toLowerCase(), item: pi[2].toUpperCase() };
  const gate = GATE_REF.exec(t);
  if (gate) return { kind: 'gate', key: gate[1] };
  return null;
}

/** Work-item id shapes loose in prose — the P-008 auto-detect surface. Word-
 *  bounded so 'WI-123' matches inside a sentence but 'XWI-123' does not. */
const BODY_WORK_ITEM = /\b((?:WI|EI)-\d+)\b/g;

/**
 * Auto-detect hydratable refs in free prose (P-008). Deliberately NARROW:
 * work-item ids only (WI-/EI-), the shapes agents cite constantly and receivers
 * re-fetch or half-remember. De-duped, first-`max` in order of appearance.
 * (F- ids are excluded from auto-detect: too collision-prone in prose.)
 */
export function detectBodyRefs(text: string, max = DEFAULT_REF_BUDGET.maxRefs): HydratableRef[] {
  const out: HydratableRef[] = [];
  const seen = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(BODY_WORK_ITEM)) {
    const id = m[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: 'work-item', id });
    if (out.length >= max) break;
  }
  return out;
}

/** Stable key for de-dupe / budget accounting. */
export function canonicalRefKey(ref: HydratableRef): string {
  switch (ref.kind) {
    case 'msg':
      return `msg:${ref.id}`;
    case 'work-item':
      return `work-item:${ref.id}`;
    case 'plan-item':
      return `plan-item:${ref.slug}#${ref.item}`;
    case 'gate':
      return `gate:${ref.key}`;
    case 'owner-turn':
      return 'owner-turn';
  }
}

/**
 * Clamp verbatim content to a single bounded line: newlines/runs of whitespace
 * collapse to single spaces; cut at `n` chars with a trailing ellipsis. The
 * snippet must stay VERBATIM in what it shows — clamping trims, never rewrites.
 */
export function clampSnippet(text: string, n: number): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= n) return oneLine;
  return `${oneLine.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}

/**
 * Apply the budget: de-dupe by canonical key, keep the first `maxRefs` in
 * order. Pure — resolution happens in the IO half on the survivors only.
 */
export function applyRefBudget(
  refs: HydratableRef[],
  budget: RefHydrationBudget = DEFAULT_REF_BUDGET,
): HydratableRef[] {
  const out: HydratableRef[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const key = canonicalRefKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= budget.maxRefs) break;
  }
  return out;
}

/**
 * Render one hydration to the injection-line form. Verbatim content is always
 * quoted so a reader can tell platform-read words from the sender's own prose —
 * the anti-telephone-game property (D-005: the original words travel with the
 * relay, next to the paraphrase, so drift is visible at every hop).
 */
export function renderHydratedRef(h: HydratedRef): string {
  if (!h.ok) return `↪ ${h.label} — unresolved (${h.error ?? 'unknown'})`;
  return h.snippet ? `↪ ${h.label}: "${h.snippet}"` : `↪ ${h.label}`;
}

/** Render a hydration block (one line per ref) — '' for an empty list. */
export function renderHydratedRefs(hs: HydratedRef[]): string {
  return hs.map(renderHydratedRef).join('\n');
}

/**
 * The P-005 related_msg_id REPLY-QUOTE inline suffix: appended to a delivered
 * [coord+N] line whose envelope carries `related_msg_id` (a reply / escalation
 * resolution), quoting the REFERENCED message — sender, ts, bounded verbatim
 * snippet — so the receiver reads the exchange without a fetch, even when they
 * compacted the original away. `⤷ re` (not `↪`) so a reply-quote reads
 * distinctly from a relay/ref hydration on the same line. An unresolved ref
 * stays VISIBLE (the fail-soft contract) — never silently dropped.
 */
export function renderReplyQuoteSuffix(h: HydratedRef): string {
  if (!h.ok) return ` ⤷ re ${h.label} — unresolved (${h.error ?? 'unknown'})`;
  return h.snippet ? ` ⤷ re ${h.label}: "${h.snippet}"` : ` ⤷ re ${h.label}`;
}

// ─────────────────────────── P-006: gateRefs ───────────────────────────

/** Gate-key status at SEND time (checked against the announced-gates store):
 *  `declared` = announced, not yet fired; `fired` = latched (proceed, don't
 *  wait); `undeclared` = no announcement matches (typo, or a machine-derived
 *  key that needs none); `unknown` = the probe failed (fail-soft). */
export type GateRefStatus = 'declared' | 'fired' | 'undeclared' | 'unknown';

export interface GateRefStamp {
  /** The EXACT event key — the whole point: it travels verbatim, so the
   *  receiver copies (or `events:await { fromMsg }`-resolves) it, never
   *  re-types it. */
  key: string;
  status: GateRefStatus;
}

/** The reserved envelope field gateRef stamps ride on (array — same
 *  pass-through contract as cueAuthority / relayProvenance). */
export const GATE_REFS_FIELD = 'gateRefs';
/** Cap per message — a send that names more gates than this is prose, not
 *  coordination. */
export const GATE_REFS_MAX = 3;

const GATE_STATUSES: ReadonlySet<string> = new Set(['declared', 'fired', 'undeclared', 'unknown']);

/**
 * Read + validate gateRef stamps off an envelope. Defensive: absent/malformed
 * → [] (never throws); malformed entries are dropped individually; capped.
 */
export function readGateRefs(env: Record<string, unknown> | null | undefined): GateRefStamp[] {
  const raw = env?.[GATE_REFS_FIELD];
  if (!Array.isArray(raw)) return [];
  const out: GateRefStamp[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const { key, status } = s as Record<string, unknown>;
    if (typeof key !== 'string' || !key.trim()) continue;
    if (typeof status !== 'string' || !GATE_STATUSES.has(status)) continue;
    out.push({ key: key.trim(), status: status as GateRefStatus });
    if (out.length >= GATE_REFS_MAX) break;
  }
  return out;
}

/**
 * The inline `⛩` delivery suffix: each declared gate rendered with its EXACT
 * key + send-time status. NEVER clipped by the line's text cap (it is appended
 * after the clip) — a truncated gate key is worse than none, since a receiver
 * copying it would strand on a near-miss.
 */
export function renderGateRefsSuffix(stamps: GateRefStamp[]): string {
  if (!stamps.length) return '';
  return ` ⛩ ${stamps.map((s) => `gate ${s.key} [${s.status}]`).join('; ')}`;
}
