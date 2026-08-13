/**
 * Redundant-migration detection for the `db:next-migration` chokepoint (WI-38353).
 *
 * `db:next-migration` is atomic for the NUMBER (advisory lock — two agents can
 * never collide on the same NNN) but had no notion of INTENT: it would hand out
 * four numbers for four identical repairs without a word. Measured live on
 * 2026-08-13, four agents responding to ONE green-checkpoint red reserved
 * 816/817/818/819 in 48 seconds and applied four near-identical
 * `backfill-migration-reservation-815` files. Migration numbers are a monotonic
 * shared namespace and applied migrations are immutable (`schema_migrations` is
 * keyed by filename), so that waste is permanent and ungarbage-collectable.
 *
 * Broadcasting the resolution is NOT a sufficient remedy and this is measured,
 * not assumed: a stand-down broadcast went out, the peer confirmed it in words
 * ("I write no 819 file"), and 819 was written and APPLIED 85 seconds later
 * anyway. Social coordination does not serialise a stampede. The one place
 * every racer provably passes through is the reservation itself — so the check
 * belongs HERE, at the chokepoint, not in the message layer.
 *
 * The signal is the FILENAME SLUG, not the free-text `intent`. Both doors
 * (`scripts/next-migration.mjs` and the `db:next-migration` MCP tool) already
 * compute the slug identically from `--name`, and the four racers' slugs were
 * near-identical while their prose intents were merely similar. Slug is the
 * cheaper and stronger discriminator.
 *
 * This module is PURE (no DB, no clock, no fs) so both doors share one
 * implementation instead of drifting apart, and so its thresholds can be
 * falsified in a unit test with deliberately-wrong controls rather than by
 * mutating the shared tree.
 */

/**
 * Dice coefficient at which two slugs are treated as the same work.
 *
 * Calibrated against the real incident and its near-misses:
 *   backfill-migration-reservation-815        vs …-815            → 1.00 (block)
 *   backfill-migration-reservation-815        vs …-815-wi38348    → 0.89 (block)
 *   backfill-migration-reservation-815        vs …-816            → 0.75 (clear — a
 *     different target number is different work)
 *   add-foo-index                             vs add-bar-index    → 0.67 (clear)
 * A threshold below ~0.78 starts flagging the last two, which are legitimately
 * distinct migrations; the guard test pins both directions.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

/**
 * A near-identical slug reserved this recently is a STAMPEDE, not a follow-up:
 * nobody legitimately authors two near-identical migrations within half an hour.
 * The observed race spanned 48 seconds.
 */
export const DEFAULT_RACE_WINDOW_MS = 30 * 60 * 1000;

/**
 * A near-identical slug already APPLIED this recently is provably redundant
 * work — the repair you are about to author has already landed. Recency is what
 * makes it evidence of a race: an applied migration with a similar name from
 * months ago says nothing about what you are doing now.
 */
export const DEFAULT_APPLIED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Beyond the blocking windows, a similar slug is still worth SAYING. */
export const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The slug of a migration filename — `816-backfill-foo.sql` → `backfill-foo`.
 * Tolerates the `.DRAFT` / `.PENDING-CODE-DEPLOY` suffixes this repo uses to
 * hide an unfinished migration from the runner, so a draft still counts as
 * work-in-flight.
 *
 * @param {string} filename
 * @returns {string}
 */
export function slugOfMigrationFilename(filename) {
  return String(filename ?? '')
    .trim()
    .replace(/^\d+-/, '')
    .replace(/\.sql(\..*)?$/i, '')
    .toLowerCase();
}

/**
 * Unique hyphen/underscore-separated tokens of a slug.
 *
 * @param {string} slug
 * @returns {Set<string>}
 */
export function slugTokens(slug) {
  return new Set(
    String(slug ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/**
 * Sørensen–Dice similarity over the two slugs' token sets, in [0, 1].
 *
 * Token-set Dice rather than raw edit distance because migration slugs are
 * word-structured: `backfill-migration-reservation-815` and
 * `backfill-migration-reservation-815-wi38348` differ by a whole appended token
 * (a work-item id), which edit distance over-penalises for long slugs and
 * under-penalises for short ones.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function slugSimilarity(a, b) {
  const ta = slugTokens(a);
  const tb = slugTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * @typedef {object} ReservationCandidate
 * @property {number} num              The reserved migration number.
 * @property {string} filename         The reserved `NNN-slug.sql` filename.
 * @property {string} [reservedBy]     Ledger label of whoever reserved it.
 * @property {string} [intent]         Free-text intent, echoed back for context.
 * @property {number} [reservedAtMs]   Epoch ms the number was reserved.
 * @property {number|null} [appliedAtMs] Epoch ms it was applied, null/undefined if not.
 */

/**
 * @typedef {object} RedundancyMatch
 * @property {number} num
 * @property {string} filename
 * @property {string} slug
 * @property {number} similarity
 * @property {string|null} reservedBy
 * @property {string|null} intent
 * @property {boolean} applied
 * @property {number|null} ageMs      Age of the most recent relevant event.
 * @property {'block'|'warn'} severity
 * @property {string} reason
 */

/**
 * Judge whether the slug about to be reserved duplicates work already reserved
 * or applied.
 *
 * Deliberately fail-OPEN on missing data: a candidate with no timestamp can
 * still WARN but never BLOCK. Refusing on absent evidence would wedge the one
 * chokepoint every migration passes through, which is a worse failure than the
 * duplication this prevents.
 *
 * @param {object} opts
 * @param {string} opts.slug                     The slug about to be reserved.
 * @param {ReservationCandidate[]} opts.candidates
 * @param {number} opts.nowMs                    Injected clock (keeps this pure).
 * @param {number} [opts.threshold]
 * @param {number} [opts.raceWindowMs]
 * @param {number} [opts.appliedWindowMs]
 * @param {number} [opts.lookbackMs]
 * @returns {{ verdict: 'clear'|'warn'|'block', matches: RedundancyMatch[] }}
 */
export function judgeRedundantReservation({
  slug,
  candidates,
  nowMs,
  threshold = DEFAULT_SIMILARITY_THRESHOLD,
  raceWindowMs = DEFAULT_RACE_WINDOW_MS,
  appliedWindowMs = DEFAULT_APPLIED_WINDOW_MS,
  lookbackMs = DEFAULT_LOOKBACK_MS,
}) {
  const target = String(slug ?? '').trim();
  /** @type {RedundancyMatch[]} */
  const matches = [];
  if (!target || !Array.isArray(candidates)) return { verdict: 'clear', matches };

  for (const c of candidates) {
    const candSlug = slugOfMigrationFilename(c?.filename ?? '');
    const similarity = slugSimilarity(target, candSlug);
    if (similarity < threshold) continue;

    const appliedAtMs = c?.appliedAtMs ?? null;
    const reservedAtMs = c?.reservedAtMs ?? null;
    const applied = appliedAtMs != null;
    const eventMs = appliedAtMs ?? reservedAtMs;
    const ageMs = eventMs == null ? null : nowMs - eventMs;

    /** @type {'block'|'warn'|null} */
    let severity = null;
    let reason = '';
    if (applied && ageMs != null && ageMs <= appliedWindowMs) {
      severity = 'block';
      reason = 'a near-identical migration is ALREADY APPLIED — this repair has landed';
    } else if (!applied && ageMs != null && ageMs <= raceWindowMs) {
      severity = 'block';
      reason = 'a peer reserved a near-identical migration moments ago — you are racing them';
    } else if (ageMs == null || ageMs <= lookbackMs) {
      severity = 'warn';
      reason = applied
        ? 'a near-identical migration was applied earlier'
        : 'a near-identical migration is reserved but unapplied';
    }
    if (!severity) continue;

    matches.push({
      num: Number(c.num),
      filename: String(c.filename ?? ''),
      slug: candSlug,
      similarity,
      reservedBy: c?.reservedBy ?? null,
      intent: c?.intent ?? null,
      applied,
      ageMs,
      severity,
      reason,
    });
  }

  matches.sort((a, b) => b.similarity - a.similarity || b.num - a.num);
  const verdict = matches.some((m) => m.severity === 'block')
    ? 'block'
    : matches.length > 0
      ? 'warn'
      : 'clear';
  return { verdict, matches };
}

/**
 * Fetch the reservation/applied rows to judge against, using the CALLER's
 * transaction so the read happens under the same advisory lock that serialises
 * allocation — otherwise a racer could reserve between our read and our insert,
 * which is the exact window this guard exists to close.
 *
 * Both doors pass a postgres.js tagged-template handle (the CLI's `tx`, the MCP
 * tool's `tx`), so the query itself is shared rather than reimplemented twice.
 *
 * Applied-but-never-reserved migrations are UNIONed in deliberately: migration
 * 815 — the very file this incident was about — was applied with no reservation
 * row, so a reservations-only read would have been blind to the thing being
 * duplicated.
 *
 * @param {any} tx postgres.js tagged-template handle inside a transaction.
 * @param {{ lookbackMs?: number, limit?: number }} [opts]
 * @returns {Promise<ReservationCandidate[]>}
 */
export async function fetchRedundancyCandidates(tx, { lookbackMs = DEFAULT_LOOKBACK_MS, limit = 500 } = {}) {
  const lookbackSecs = Math.max(1, Math.round(lookbackMs / 1000));
  const rows = await tx`
    SELECT num, filename, reserved_by, intent, reserved_at_ms, applied_at_ms FROM (
      SELECT r.num::int AS num,
             r.filename,
             r.reserved_by,
             r.intent,
             (EXTRACT(EPOCH FROM r.reserved_at) * 1000)::bigint AS reserved_at_ms,
             (SELECT (EXTRACT(EPOCH FROM m.applied_at) * 1000)::bigint
                FROM harness_shared.schema_migrations m
               WHERE m.filename LIKE r.num || '-%'
               LIMIT 1) AS applied_at_ms
        FROM harness_shared.migration_reservations r
       WHERE r.reserved_at > now() - make_interval(secs => ${lookbackSecs})
      UNION ALL
      SELECT substring(m.filename FROM '^([0-9]+)-')::int AS num,
             m.filename,
             NULL AS reserved_by,
             NULL AS intent,
             NULL::bigint AS reserved_at_ms,
             (EXTRACT(EPOCH FROM m.applied_at) * 1000)::bigint AS applied_at_ms
        FROM harness_shared.schema_migrations m
       WHERE m.filename ~ '^[0-9]+-'
         AND m.applied_at > now() - make_interval(secs => ${lookbackSecs})
         AND NOT EXISTS (SELECT 1 FROM harness_shared.migration_reservations r2
                          WHERE r2.num = substring(m.filename FROM '^([0-9]+)-')::int)
    ) candidates
    ORDER BY num DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    num: Number(r.num),
    filename: String(r.filename ?? ''),
    reservedBy: r.reserved_by ?? null,
    intent: r.intent ?? null,
    reservedAtMs: r.reserved_at_ms == null ? null : Number(r.reserved_at_ms),
    appliedAtMs: r.applied_at_ms == null ? null : Number(r.applied_at_ms),
  }));
}

/** @param {number|null} ms */
function humanAge(ms) {
  if (ms == null) return 'unknown age';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Render a judgement for a human/agent reader.
 *
 * The imperative leads the first line on purpose: coord delivery truncates at
 * 600 chars and agents skim, so a message whose actionable clause is buried
 * below evidence does not change behaviour.
 *
 * @param {{ verdict: 'clear'|'warn'|'block', matches: RedundancyMatch[] }} judgement
 * @param {{ slug: string, forceFlag?: string }} opts
 * @returns {string|null}
 */
export function formatRedundancyMessage(judgement, { slug, forceFlag = '--force' }) {
  if (!judgement || judgement.verdict === 'clear' || judgement.matches.length === 0) return null;
  const blocking = judgement.verdict === 'block';
  const lines = [];
  lines.push(
    blocking
      ? `STOP — this migration looks ALREADY DONE. Do not write it; check the number(s) below first.`
      : `HEADS UP — a near-identical migration already exists. Check it before writing yours.`,
  );
  lines.push(`  your slug: ${slug}`);
  for (const m of judgement.matches.slice(0, 5)) {
    const who = m.reservedBy ? ` by ${m.reservedBy}` : '';
    const state = m.applied ? 'APPLIED' : 'reserved, unapplied';
    lines.push(
      `  ${String(m.num).padStart(3, '0')}  ${m.filename}  [${state}${who}, ${humanAge(m.ageMs)}, similarity ${m.similarity.toFixed(2)}]`,
    );
    lines.push(`       ${m.reason}`);
    if (m.intent) lines.push(`       intent: ${m.intent}`);
  }
  if (blocking) {
    lines.push(
      `If you already hold one of these numbers, WRITE YOUR FILE THERE rather than reserving another.`,
    );
    lines.push(
      `If this really is distinct work that merely reads alike, re-run with ${forceFlag} to reserve anyway.`,
    );
  }
  return lines.join('\n');
}
