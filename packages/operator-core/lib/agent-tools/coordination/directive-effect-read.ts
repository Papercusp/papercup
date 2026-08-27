/**
 * directive-effect-read.ts — the fleet-health READ half of P-013.
 *
 * directive-effect.ts owns the VERDICT (given an expectation and the ledger row, was
 * the effect carried out after the directive?). This module owns finding the
 * expectations in the first place: `coord:send { expectEffect }` stamps them on the
 * envelope, so they are recovered by scanning coord_event_log — no side table, no
 * write path, nothing to keep in sync.
 *
 * Split out from the resolver on purpose: the resolver reads the ORG handle
 * (harness_shared.work_items / carry_notes) while this reads the COORD handle
 * (coord_event_log), exactly the way unanswered-directed.ts does. Keeping the two
 * handles in one module invites a future edit to blur them.
 */
import {
  DIRECTIVE_EFFECT_KINDS,
  fetchDirectiveActuations,
  summarizeActuations,
  type DirectiveActuation,
  type DirectiveActuationSummary,
  type DirectiveEffectKind,
  type DirectiveEffectSpec,
} from './directive-effect';
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';

/** How far back a directive still counts as "outstanding" — mirrors
 *  UNANSWERED_LOOKBACK_MS: an ancient directive is not fleet health, it is noise. */
export const DIRECTIVE_EFFECT_LOOKBACK_MS = 3 * 24 * 3600 * 1000;
/** Hard cap on envelopes scanned per read, so one chatty sender cannot bloat a brief. */
export const DIRECTIVE_EFFECT_SCAN_CAP = 200;

/** One envelope carrying an `expectEffect` stamp — the REAL shape the SQL selects. */
export interface DirectiveEffectEnvelopeRow {
  recipient: string;
  from_id: string;
  msg_id: string;
  /** epoch ms; bigint arrives as a string from postgres-js. */
  ts_ms: string | number;
  effect: unknown;
}

/**
 * PURE: parse an envelope's stamped `expectEffect` back into a spec.
 *
 * Returns null for anything that is not a recognised kind plus a non-empty id. An
 * envelope written by an older or newer sender is SKIPPED, never guessed at — a
 * half-understood expectation would produce a confident verdict about an effect
 * nobody actually declared, which is the one output this feature must never emit.
 */
export function parseEffectStamp(raw: unknown): DirectiveEffectSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const kind = String(rec.kind ?? '');
  const itemId = String(rec.itemId ?? '').trim();
  if (!itemId) return null;
  if (!(DIRECTIVE_EFFECT_KINDS as readonly string[]).includes(kind)) return null;
  const harness = String(rec.harness ?? '').trim();
  return { kind: kind as DirectiveEffectKind, itemId, ...(harness ? { harness } : {}) };
}

/** PURE: envelope rows → the per-recipient spec list the probe takes. Skips
 *  unparseable stamps and rows whose timestamp is unusable. */
export function envelopeRowsToSpecs(
  rows: readonly DirectiveEffectEnvelopeRow[],
): Map<string, Array<DirectiveEffectSpec & { sentAtMs: number; msgId: string }>> {
  const out = new Map<string, Array<DirectiveEffectSpec & { sentAtMs: number; msgId: string }>>();
  for (const r of rows) {
    const spec = parseEffectStamp(r.effect);
    if (!spec) continue;
    const sentAtMs = Number(r.ts_ms);
    if (!Number.isFinite(sentAtMs) || sentAtMs <= 0) continue;
    const list = out.get(r.recipient) ?? [];
    list.push({ ...spec, sentAtMs, msgId: r.msg_id });
    out.set(r.recipient, list);
  }
  return out;
}

/**
 * The fleet-health read: per recipient, how many of the directives sent to them were
 * actually ACTED ON. `fromId` narrows to one sender's directives — a leader asks about
 * ITS OWN instructions, not every message anyone ever sent that member.
 *
 * Best-effort like its siblings (fetchUnansweredDirected / decorateContextPressure):
 * gated on the coord PG fast path, empty map on any failure. A decoration must never
 * be able to fail the brief it decorates.
 */
export async function fetchDirectiveActuationSummaries(
  recipientIds: string[],
  opts: { fromId?: string; nowMs?: number; lookbackMs?: number; workspaceId?: string } = {},
): Promise<Map<string, DirectiveActuationSummary>> {
  if (recipientIds.length === 0 || !coordHasPgFastPath()) return new Map();
  try {
    const nowMs = opts.nowMs ?? Date.now();
    const sinceMs = nowMs - (opts.lookbackMs ?? DIRECTIVE_EFFECT_LOOKBACK_MS);
    const sql = coordSql();
    const ws = coordWorkspaceId();
    const from = opts.fromId ?? null;
    const rows = await sql<DirectiveEffectEnvelopeRow[]>`
      SELECT r AS recipient,
             e.body->>'from' AS from_id,
             e.body->>'msg_id' AS msg_id,
             (extract(epoch FROM (e.body->>'ts')::timestamptz) * 1000)::bigint AS ts_ms,
             e.body->'expectEffect' AS effect
        FROM harness_shared.coord_event_log e
        CROSS JOIN LATERAL jsonb_array_elements_text(e.body->'to') AS r
       WHERE e.workspace_id = ${ws}
         AND e.surface = 'messages'
         AND e.body ? 'expectEffect'
         AND jsonb_typeof(e.body->'to') = 'array'
         AND r = ANY(${recipientIds}::text[])
         AND e.body->>'from' IS DISTINCT FROM r
         AND (${from}::text IS NULL OR e.body->>'from' = ${from})
         AND (e.body->>'ts')::timestamptz >= to_timestamp(${sinceMs}::double precision / 1000)
       ORDER BY (e.body->>'ts')::timestamptz DESC
       LIMIT ${DIRECTIVE_EFFECT_SCAN_CAP}`;
    const byRecipient = envelopeRowsToSpecs(rows);
    if (byRecipient.size === 0) return new Map();

    // ONE probe for every recipient's expectations together (the batched-decoration
    // contract: enriching N members costs one read, not N).
    const flat = [...byRecipient.entries()].flatMap(([recipient, specs]) =>
      specs.map((spec) => ({ recipient, spec })),
    );
    const actuations = await fetchDirectiveActuations(
      flat.map((f) => f.spec),
      // The envelope query and the ledger probe must use the SAME resolved
      // workspace. Dropping `ws` here makes the probe fall back to the ambient
      // workspace, so a row found in the coord partition is reported as
      // unprovable when the org ledger is on a different workspace partition.
      { workspaceId: ws },
    );
    const grouped = new Map<string, DirectiveActuation[]>();
    flat.forEach((f, i) => {
      const a = actuations[i];
      if (!a) return;
      const list = grouped.get(f.recipient) ?? [];
      list.push(a);
      grouped.set(f.recipient, list);
    });
    return new Map([...grouped].map(([k, v]) => [k, summarizeActuations(v)]));
  } catch {
    return new Map();
  }
}
