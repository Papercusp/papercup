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
  notify: { glyph: '.', name: 'notify — subscription delta' },
  plan_event: { glyph: '~', name: 'plan event' },
  subscribe: { glyph: '.', name: 'subscribe' },
  unsubscribe: { glyph: '.', name: 'unsubscribe' },
  contract: { glyph: '~', name: 'contract' },
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
  summary?: string;
  body?: string;
  ts: string;
  plan_slug?: string;
  // digest-notify coalescing fields
  subject?: string;
  digest?: boolean;
}

/**
 * The glyph for one entry: its lifecycle category if it has one, else its kind,
 * else the default. The ONE place a line's glyph is decided — both the wire and
 * the legend route through `COORD_LEGEND`, so they can't disagree.
 */
export function glyphFor(entry: Pick<CoordLineSource, 'kind' | 'lifecycle'>): string {
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
    const text = clip(e.summary || e.body || '(no summary)', textCap);
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
  ].join('\n');
}
