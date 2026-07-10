/**
 * coord-schema — the SINGLE SOURCE for the coord-injection line protocol
 * (plan `token-efficient-coord-injection-2026-06-06`, D-001/D-002).
 *
 * Coord `[coord] …` blocks are PUSHED into every psu turn continuously, so they
 * are the highest-leverage token surface in the system. A coord line has one
 * FIXED schema, identical every injection, with the operator (renderer) and the
 * model (reader) both ours — so the schema does not belong on the wire. It is
 * declared ONCE, out-of-band, in the psu prompt (`renderCoordLegend`), and only
 * VALUES travel: a positional line `<glyph> <handle> <text>`.
 *
 * Everything downstream derives from the ONE `COORD_LEGEND` map here:
 *   - the server-side injection renderer (`renderInjection`) — what goes on the wire,
 *   - the psu-prompt legend (`renderCoordLegend`) — what the model reads,
 * so the two cannot desync (the anti-desync equality test asserts it). This
 * absorbs the formerly-scattered schema: `CoordKind` (pubsub-substrate),
 * `LIFECYCLE_CATEGORIES` (coord-lifecycle/records), and the glyphs that used to
 * be inline in `coord-lifecycle/render.ts`.
 *
 * Glyphs are SINGLE ASCII chars (1 token each — emoji like ▶ ↪ ⚠ tokenize to 2-3
 * tokens, which is pure waste on a per-injection surface; verified by the P-006
 * benchmark). The glyph is applied here, at render-to-display time, NOT baked
 * into the stored record prose (render.ts is glyph-free) — presentation is a
 * projection of the record, not part of it.
 */

import type { CoordKind } from '@papercusp/coordination/core';
import { LIFECYCLE_CATEGORIES } from './coord-lifecycle/records';
import { readCueAuthority, renderCueAuthorityTag } from './agent-tools/coordination/cue-authority';

export interface LegendEntry {
  glyph: string;
  /** Human-readable name shown in the prompt legend. */
  name: string;
}

/**
 * The canonical line type → {glyph, name}. Keys are the lifecycle CATEGORIES
 * (completion/claim/intent/window/handoff/finding) plus the base `CoordKind`s.
 * A lifecycle message (kind=`message` + a lifecycle `category`) is keyed by its
 * category; everything else by its kind. Glyphs are distinct 1-token ASCII.
 */
export const COORD_LEGEND: Record<string, LegendEntry> = {
  // ── lifecycle categories (the common, high-volume cases) ──
  intent: { glyph: '>', name: 'intent — now working on' },
  completion: { glyph: '*', name: 'completion — finished' },
  claim: { glyph: '+', name: 'claim — taking a work-item' },
  window: { glyph: '#', name: 'scope window — holding / draining / released (the verb says which)' },
  handoff: { glyph: '<', name: 'handoff — passing work to a peer' },
  finding: { glyph: '!', name: 'finding — a discovered problem' },
  // ── base CoordKinds (non-lifecycle) ──
  message: { glyph: '-', name: 'message — free-text note' },
  ack: { glyph: '=', name: 'ack — acknowledgement' },
  escalation: { glyph: '^', name: 'escalation — needs attention' },
  escalation_resolved: { glyph: '=', name: 'escalation resolved' },
  handoff_accepted: { glyph: '<', name: 'handoff accepted' },
  handoff_repinged: { glyph: '<', name: 'handoff re-ping — your offer is still un-acked' },
  notify: { glyph: '.', name: 'notify — subscription delta' },
  plan_event: { glyph: '~', name: 'plan event' },
  subscribe: { glyph: '.', name: 'subscribe' },
  unsubscribe: { glyph: '.', name: 'unsubscribe' },
  contract: { glyph: '~', name: 'contract' },
  // turn-lifecycle-control Phase 4 (P-019): interrupt = wake's dual. A
  // cooperative turn:interrupt — wrap up at a safe checkpoint + end your turn.
  yield: { glyph: '|', name: 'yield — a peer asks you to wrap up + end your turn (turn:interrupt)' },
};

/** The default glyph for an unknown line type (defensive — never throws). */
const DEFAULT_GLYPH = '-';

const LIFECYCLE_SET = new Set<string>(LIFECYCLE_CATEGORIES);

/** Minimal shape the injection renderer needs from a coord entry. */
export interface CoordLineSource {
  from: string;
  kind: CoordKind | string;
  /**
   * Lifecycle category (`intent`/`completion`/…). `coord:emit` stamps this on
   * the envelope's `lifecycle` field (NOT `category`, which is reserved for
   * ambient tags like `service-health` — see emit.ts). The glyph keys on this.
   */
  lifecycle?: string;
  /** Ambient classification tag (`service-health`/…) — not a lifecycle category. */
  category?: string;
  /** The envelope's addressee list, when the caller passes it through (inbox does —
   *  entries are cast wholesale). Read ONLY by the directed-question clip (P-004);
   *  `unknown` so a malformed/absent value degrades to "not directed", never throws. */
  to?: unknown;
  /** Audience-selector stamp (`@fleet:…`/'*') — present ⇒ a fan-out, not a directed
   *  message, even though `to` resolved to concrete ownerIds at send time. */
  audience?: unknown;
  summary?: string;
  body?: string;
  ts: string;
  plan_slug?: string;
  // digest-notify coalescing fields
  subject?: string;
  digest?: boolean;
  /**
   * Structured authority + scope of a CONTROL cue (drain / pause / steer) — the
   * `cueAuthority` envelope field an emit site stamps via sendMessage.extra
   * (queen-fleet-authority-boundary P-003). When present + well-formed, the line
   * is prefixed with a `[hive-queen(<hive>)→hive-wide]` /
   * `[fleet-leader(<slug>)→fleet-members(<slug>)]` tag so a recipient sees at a
   * glance whether it's a hive-wide Queen pause or a fleet leader draining its own
   * members. `unknown` (validated by readCueAuthority) so a legacy/forged value is
   * simply ignored, never rendered. */
  cueAuthority?: unknown;
}

/**
 * The glyph for one entry: its lifecycle category if it has one, else its kind,
 * else the default. The ONE place a line's glyph is decided — both the wire and
 * the legend route through `COORD_LEGEND`, so they can't disagree.
 */
export function glyphFor(entry: Pick<CoordLineSource, 'kind' | 'lifecycle' | 'category'>): string {
  if (entry.lifecycle && LIFECYCLE_SET.has(entry.lifecycle)) {
    return COORD_LEGEND[entry.lifecycle]?.glyph ?? DEFAULT_GLYPH;
  }
  return COORD_LEGEND[entry.kind as string]?.glyph ?? DEFAULT_GLYPH;
}

/**
 * Short, stable handle from an owner id — shown ONCE per line (the lifecycle
 * prose no longer re-embeds the sender). `su-ab53332d-…` → `ab533`,
 * `omp-<sid>-<pid>` → first 5 of `<sid>`. Deterministic, no DB lookup.
 */
export function shortHandle(from: string): string {
  if (!from) return '?';
  // Strip a known client prefix, then take the first 5 alphanumerics.
  const stripped = from.replace(/^(su|omp|cc|codex)-/, '');
  const m = stripped.match(/[A-Za-z0-9]+/);
  const core = (m ? m[0] : stripped).slice(0, 5);
  return core || from.slice(0, 5);
}

/** Collapse a long summary to one scannable line. */
function clip(s: string, max = 200): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** Extended per-line budget for a DIRECTED question (fleet-leader-frictions P-004):
 *  a question addressed to YOU is the highest-priority line in the block, yet the
 *  200-char clip routinely severed the ask mid-sentence ("…was ON in PostHo…"),
 *  forcing a coord:inbox re-read just to learn what was asked. Bounded — this is a
 *  clip extension for the ask sentence, not an unclipped body channel. */
const DIRECTED_QUESTION_CAP = 500;

/** A line is DIRECTED when the sender enumerated concrete recipients: no '*' / 'human'
 *  in `to`, and no `audience` stamp (selector fan-outs resolve to concrete ownerIds but
 *  are broadcasts in intent). Defensive over `unknown` — malformed ⇒ not directed. */
function isDirected(e: Pick<CoordLineSource, 'to' | 'audience'>): boolean {
  if (e.audience != null) return false;
  const to = e.to;
  if (!Array.isArray(to) || to.length === 0) return false;
  return to.every((t) => typeof t === 'string' && t !== '*' && t !== 'human');
}

/** clip(), except a question sentence survives: when the text overflows `max` and its
 *  last '?' lies past the plain-clip window but within `hardCap`, cut just AFTER that
 *  '?' (the ask stays intact) instead of mid-question. No '?' in reach ⇒ plain clip. */
function clipKeepQuestion(s: string, max: number, hardCap: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  const lastQ = oneLine.lastIndexOf('?', hardCap - 1);
  // A '?' at index ≤ max-2 already survives the plain clip (which keeps max-1 chars).
  if (lastQ < max - 1) return `${oneLine.slice(0, max - 1)}…`;
  const kept = oneLine.slice(0, lastQ + 1);
  return lastQ + 1 >= oneLine.length ? kept : `${kept} …`;
}

/**
 * Coalesce digest-mode notifies by `subject` (the noise control, formerly in the
 * omp hook). Same-subject digest notifies collapse to ONE line with a count +
 * the latest summary; everything else passes through in order.
 */
function collapseDigestNotifies(entries: CoordLineSource[]): CoordLineSource[] {
  const out: CoordLineSource[] = [];
  const groups = new Map<string, CoordLineSource & { _count: number }>();
  for (const e of entries) {
    if (e.kind === 'notify' && e.digest) {
      const key = e.subject ?? e.summary ?? '?';
      const g = groups.get(key);
      if (!g) {
        const ne = { ...e, _count: 1 };
        groups.set(key, ne);
        out.push(ne);
      } else {
        g._count += 1;
        if (e.ts > g.ts) {
          g.ts = e.ts;
          g.summary = e.summary;
        }
      }
    } else {
      out.push(e);
    }
  }
  for (const g of groups.values()) {
    if (g._count > 1) {
      const subj = g.subject ?? '';
      g.summary = `${subj ? `${subj} ` : ''}×${g._count} — latest: ${g.summary ?? ''}`;
    }
  }
  return out;
}

/**
 * Collapse repeated INTENT lines to latest-per-peer (D-005): only a peer's newest
 * "now working on" matters, so older intents from the same `from` are dropped.
 */
function collapseIntents(entries: CoordLineSource[]): CoordLineSource[] {
  const latestIntentTs = new Map<string, string>();
  for (const e of entries) {
    if (e.lifecycle === 'intent') {
      const prev = latestIntentTs.get(e.from);
      if (!prev || e.ts > prev) latestIntentTs.set(e.from, e.ts);
    }
  }
  return entries.filter((e) => {
    if (e.lifecycle !== 'intent') return true;
    return latestIntentTs.get(e.from) === e.ts;
  });
}

export interface RenderInjectionOpts {
  /** Max lines shown; older are summarized as a count. Default 8. */
  maxLines?: number;
  /** Per-line text cap. Default 200. */
  textCap?: number;
}

/**
 * Render a coord delta into the positional injection block (D-001):
 *
 *   [coord+N]
 *   <glyph> <handle> <text>
 *   …
 *   …+K older
 *
 * No per-block column header (the schema is in the prompt legend) and NO footer
 * (relocated to the prompt, emitted once per session). Returns '' for an empty
 * delta. Pure — fully unit-testable; the client hooks just echo the result.
 */
export function renderInjection(entries: CoordLineSource[], opts: RenderInjectionOpts = {}): string {
  if (entries.length === 0) return '';
  const maxLines = opts.maxLines ?? 8;
  const textCap = opts.textCap ?? 200;

  const collapsed = collapseIntents(collapseDigestNotifies(entries));
  const sorted = [...collapsed].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const total = sorted.length;
  const overflow = total - maxLines;
  const shown = overflow > 0 ? sorted.slice(-maxLines) : sorted;

  const lines = [`[coord+${total}]`];
  if (overflow > 0) lines.push(`…+${overflow} older`);
  for (const e of shown) {
    const glyph = glyphFor(e);
    const handle = shortHandle(e.from);
    // P-004: a directed line gets the question-preserving clip (broadcasts keep the
    // flat cap — an FYI's question is not a blocked peer waiting on the reader).
    const raw = e.summary || e.body || '(no summary)';
    const body = isDirected(e) ? clipKeepQuestion(raw, textCap, DIRECTED_QUESTION_CAP) : clip(raw, textCap);
    // queen-fleet-authority-boundary P-003: a CONTROL cue (drain/pause/steer) carries
    // a structured authority+scope stamp — surface it as a leading `[…]` tag so the
    // reader distinguishes a hive-wide Queen pause from a fleet leader draining its
    // own members. Malformed/absent → readCueAuthority returns null → no tag.
    const stamp = readCueAuthority(e as unknown as Record<string, unknown>);
    const text = stamp ? `[${renderCueAuthorityTag(stamp)}] ${body}` : body;
    lines.push(`${glyph} ${handle} ${text}`);
  }
  return lines.join('\n');
}

/**
 * The once-per-session prompt legend (Projection 2, D-002/D-004). Declares the
 * positional grammar + the glyph key + the relocated footer, so the model can
 * read every injected line WITHOUT a per-block header or per-injection footer.
 * Generated from the SAME `COORD_LEGEND` the renderer uses.
 */
export function renderCoordLegend(): string {
  const keys = Object.keys(COORD_LEGEND);
  // De-dupe by glyph for the key listing (several kinds share a glyph), but keep
  // every distinct (glyph,name) the renderer can emit so the anti-desync test
  // sees full coverage.
  const keyLines = keys.map((k) => `  \`${COORD_LEGEND[k].glyph}\` ${COORD_LEGEND[k].name}`);
  return [
    '## Coord injection protocol',
    '',
    'After your tool calls you may see a `[coord+N]` block — N coordination',
    'deltas from peers since your last call. Each line is positional:',
    '',
    '```',
    '[coord+N]',
    '<glyph> <handle> <text>',
    '```',
    '',
    '- `glyph` — the line type (key below).',
    '- `handle` — the short sender id (e.g. `ab533`); it is NOT repeated in the text.',
    '- `text` — the message; a `…+K older` line means K older deltas were elided.',
    '',
    'Glyph key:',
    ...keyLines,
    '',
    'Act on a line only if it bears on your task. Reply or hand off with',
    '`coord:send` / `coord:handoff`; read full bodies + history via `coord:inbox`',
    '/ `coord:thread`. (This guidance is here once — it is no longer repeated per',
    'injection.)',
    '',
    // WI-1720 (owner directive 2026-07-02): the receiver-side reply-priority rule.
    // Sourced-once twin of the orchestrator PEER_REPLY_PRIORITY_NOTE (prompt-build.ts,
    // the spawned-bee base) — if you reword one, reword the other to match.
    '**A DIRECTED message awaiting YOUR answer OUTRANKS your own work.** A question',
    'addressed to you, a decision only you can make, a peer blocked on something you',
    'own — that is your highest-priority work the moment it arrives: finish only the',
    'atomic step in hand, then REPLY FIRST, before the next step of your own task.',
    'If the full answer needs real work, ACK now with an ETA so the asker is never',
    'blind-waiting; reply directly (`coord:send` + `related_msg_id`, wake if parked),',
    'never batched to turn-end. Your terminal/final-response text does NOT reach the',
    'asker — an answer not SENT back via `coord:send` was never delivered; answering',
    'only in your own transcript is a silent drop. Your minutes are a blocked peer’s',
    'hours. Broadcasts and FYI chatter carry no such claim.',
  ].join('\n');
}
