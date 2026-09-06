/**
 * SU-S31 — shared world for the P-011 information-asymmetry experiment
 * (agent-protocol-authority-semantics-2026-07-26 P-011).
 *
 * ## What P-011 asked for, and why this is THREE arms rather than two
 *
 * P-011's prescribed method is "matched tasks with and without the field".
 * Taken literally that comparison is CONFOUNDED, and the confound is fatal to
 * the build decision it is supposed to inform: the treatment arm's
 * information-asymmetry field CARRIES INFORMATION the control arm does not
 * have. A two-arm win therefore only demonstrates "telling a successor more
 * things helps it" — which is trivially true and was never in doubt — and says
 * nothing about whether the *structured field* earns its place in the protocol.
 *
 * So the experiment runs three matched arms over one identical task:
 *
 *   A `control`     status-quo handoff: bare Did / Left / Next.
 *   B `prose-equal` the SAME facts, written as ordinary prose, no labeled field.
 *   C `field`       the SAME facts in a labeled knownToMe / couldNotDetermine block.
 *
 * B-vs-C is the real test of the FIELD (information held constant, only
 * structure varies). A-vs-B measures the magnitude ceiling: how much work a
 * successor redoes when simply not told.
 *
 * Decision rule, fixed BEFORE the run so the result can actually falsify:
 *   C ≈ B > A  ⇒ do NOT add a schema field. The win is "write the asymmetry
 *                down at all", which a prompt instruction buys for free.
 *   C > B      ⇒ the structure itself carries the win. Build the field.
 *   A ≈ B ≈ C  ⇒ hypothesis falsified. Build nothing.
 *
 * ## The world
 *
 * The su agent has been woken to take over item P-003 of plan
 * `reconciler-idempotency-2026-07-27` — "run the backfill for existing
 * duplicate rows". A peer (su-peer1) did the preceding item P-002 (the dedupe
 * guard) and handed off. Three facts are planted in the peer's history:
 *
 *   KNOWN-A   the guard keys on (harness, external_id), NOT on id — a backfill
 *             keyed on id double-counts. The peer verified this.
 *   KNOWN-B   staging holds 1,204 duplicate rows. The peer counted them.
 *   UNDET-C   whether the reconciler ever ran under the OLD key before
 *             2026-07-01 is UNKNOWABLE from the audit rows (none exist that
 *             far back); it needs the archived logs. The peer could not
 *             determine it, and it changes what the backfill must do.
 *
 * Every arm's world exposes the SAME tools returning the SAME answers, so
 * re-deriving A and B is always possible and always yields what the peer
 * reported. The arms differ in exactly one string: how the peer's handoff
 * conveys (or fails to convey) A, B and C.
 *
 * ## Why the metrics are tool-call based, not judge-based
 *
 * AUTHORING.md §10 warns against leaning on the judge, and a three-arm rate
 * comparison would drown in judge variance. All three primary metrics read the
 * tool-call trace instead:
 *
 *   1. duplicate-rederivation — did it re-derive A or B (re-read the guard
 *      source / re-count the dupes) that the peer already established?
 *   2. contradiction          — did it proceed with an id-keyed backfill,
 *                               against the peer's verified finding?
 *   3. asymmetry-targeting    — did it surface the genuinely-undetermined C?
 *
 * These are EXPERIMENT METRICS, not regression gates. A metric hit is emitted
 * as a WARN finding so it remains queryable per arm without making the
 * canonical `llm-test --target su` suite permanently red on the control
 * behavior the experiment explicitly expects. Real runner/infrastructure
 * errors and the shared `cost_under` assertion remain gating (EI-22442499170227708).
 *
 * The scenario `description` is fed verbatim to the judge, so it is shared
 * IDENTICALLY across all three arms (see SHARED_DESCRIPTION). Only the world
 * differs. Anything else would smuggle the arm into the prompt.
 */

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolDispatchOverride } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';

export function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

export const PLAN_SLUG = 'reconciler-idempotency-2026-07-27';
export const WORK_ITEM = 'WI-7301';
export const GUARD_FILE = 'packages/operator-core/lib/reconciler/dedupe-guard.ts';
export const GUARD_TEST = 'packages/operator-core/lib/reconciler/dedupe-key.test.ts';
export const ROW_SCHEMA_FILE = 'packages/operator-core/lib/reconciler/reconciler-row.ts';
export const BACKFILL_FILE = 'packages/operator-core/lib/reconciler/backfill-duplicates.ts';
export const DUPE_COUNT = 1204;

/* ------------------------------------------------------------------ *
 * The three handoff payloads — the ONLY thing that varies by arm.
 * ------------------------------------------------------------------ */

/** A — status quo. What the peer DID; nothing about what it knows or couldn't settle. */
export const HANDOFF_CONTROL = [
  '## Did',
  'Added the dedupe guard in dedupe-guard.ts and wired it into the reconciler tick. Unit tests green.',
  '',
  '## Left',
  'The backfill for the duplicate rows that already exist in staging.',
  '',
  '## Next',
  'Run the backfill.',
].join('\n');

/**
 * B — prose-equal. Carries A, B and C, but as ordinary narrative prose with no
 * labeled asymmetry field. This is the arm that isolates the field's STRUCTURE:
 * an agent reading this has every fact the field would have given it.
 */
export const HANDOFF_PROSE = [
  '## Did',
  'Added the dedupe guard in dedupe-guard.ts and wired it into the reconciler tick. Unit tests green.',
  `Worth mentioning that the guard ends up keyed on (harness, external_id) rather than on id — I ran`,
  `dedupe-key.test.ts to confirm that, and it matters because anything keyed on id will double-count.`,
  `I also went and counted what is already in staging and it came to ${DUPE_COUNT} duplicate rows.`,
  'One thing I never got to the bottom of: I could not tell whether the reconciler ever ran under the',
  'old key before 2026-07-01, because the audit table has no rows going back that far, so the only',
  'place that would show it is the archived logs.',
  '',
  '## Left',
  'The backfill for the duplicate rows that already exist in staging.',
  '',
  '## Next',
  'Run the backfill.',
].join('\n');

/**
 * C — the information-asymmetry field. Identical FACTS to B, in the labeled
 * structure P-011 proposes: what the writer knows that the reader may not, and
 * what the writer could not determine.
 */
export const HANDOFF_FIELD = [
  '## Did',
  'Added the dedupe guard in dedupe-guard.ts and wired it into the reconciler tick. Unit tests green.',
  '',
  '## knownToMe (established here — you would otherwise have to re-derive this)',
  `- The guard keys on (harness, external_id), NOT on id. A backfill keyed on id will double-count.`,
  `  Verified by running ${GUARD_TEST}.`,
  `- Staging currently holds ${DUPE_COUNT} duplicate rows. I counted them.`,
  '',
  '## couldNotDetermine (open — I could not settle this, and it bears on the backfill)',
  '- Whether the reconciler ever ran under the OLD key before 2026-07-01. The audit table has no rows',
  '  that far back, so it is not answerable from audit data — it needs the archived logs.',
  '',
  '## Left',
  'The backfill for the duplicate rows that already exist in staging.',
  '',
  '## Next',
  'Run the backfill.',
].join('\n');

/**
 * D — auto-derived provenance (`basedOn`). Added 2026-07-27 AFTER the A/B/C
 * result, at the suggestion of su-8d9a671c's `unified-agent-state-plane` P-014,
 * which proposes provenance "auto-derived from recent reads" as "the honest
 * replacement for guessing what the receiver knows".
 *
 * This is a DIFFERENT MECHANISM from arms B and C, not a variant of them, and
 * that is the whole point. B and C both require the SENDER to predict what the
 * receiver will need and to curate it — B in prose, C in labeled fields. Both
 * pay an authoring cost, and both fail the same way when the sender predicts
 * wrong. D pays no authoring cost at all: it is a mechanical trace of what the
 * peer read and ran, with the returned values, carrying NO interpretation.
 *
 * Note what this does and does not hand over. All three planted facts are
 * RECOVERABLE from the trace — the key from the guard read plus the passing key
 * test, the count from the COUNT result, and the undetermined question from an
 * audit query that came back empty. But none of them is STATED. So D tests
 * whether the receiver will do the inference the sender would otherwise have
 * had to do for it.
 *
 * ⚠ D is NOT part of the original pre-registered A/B/C decision rule and must
 * never be used to rescue the authored-field hypothesis that B-vs-C tested.
 * It is a separate question with its own prediction, fixed BEFORE it was run:
 *
 *   D ≈ B ≈ C > A  ⇒ the win is available for FREE. Build auto-derived
 *                    provenance, NOT an authored field. Strongest outcome for
 *                    P-014's `basedOn`.
 *   D ≈ A (< B)    ⇒ a raw trace is not enough; the receiver does not do the
 *                    inference. The value lives in the INTERPRETATION, which
 *                    only an authoring sender can supply.
 *   D > B          ⇒ surprising: a derived trace beats curated prose.
 */
export const HANDOFF_PROVENANCE = [
  '## Did',
  'Added the dedupe guard in dedupe-guard.ts and wired it into the reconciler tick. Unit tests green.',
  '',
  '## Left',
  'The backfill for the duplicate rows that already exist in staging.',
  '',
  '## Next',
  'Run the backfill.',
  '',
  '## basedOn — auto-derived from this session, not authored',
  `- read   ${GUARD_FILE}`,
  `- ran    ${GUARD_TEST} -> 1 passed`,
  `- query  SELECT count(*) FROM reconciler_rows WHERE <duplicate predicate> -> ${DUPE_COUNT}`,
  "- query  SELECT * FROM audit WHERE ts < '2026-07-01' AND actor = 'reconciler' -> 0 rows",
].join('\n');

/* ------------------------------------------------------------------ *
 * The world. Identical across arms except the injected handoff text.
 * ------------------------------------------------------------------ */

/** Source of the guard — re-deriving KNOWN-A means reading this. */
const GUARD_SOURCE = [
  'export function dedupeKey(row: ReconcilerRow): string {',
  '  // Keyed on (harness, external_id): the upstream id is re-minted per sync,',
  '  // so an id-keyed guard would treat every re-sync as a fresh row.',
  '  return `${row.harness}\\u0000${row.external_id}`;',
  '}',
].join('\n');

/** The source context the successor needs to turn the handoff into a runnable
 * backfill. Revision 2 claimed the world exposed recovery paths, but the SU
 * catalog omitted capability:read/dev:pg_query/logs:read and repomix:pack fell
 * through to an empty stub. That made the table and row shape unknowable. */
export const ROW_SCHEMA_SOURCE = [
  'export interface ReconcilerRow {',
  '  id: string;',
  '  harness: string;',
  '  external_id: string;',
  '  observed_at: Date;',
  '  payload_json: unknown;',
  '}',
  '',
  "export const RECONCILER_TABLE = 'harness_shared.reconciler_rows';",
].join('\n');

export const BACKFILL_SOURCE = [
  "import { RECONCILER_TABLE } from './reconciler-row';",
  '',
  '// Keep the oldest canonical row for each production dedupe key; archive later copies.',
  'export const duplicateBackfillSql = `',
  'WITH ranked AS (',
  '  SELECT id, row_number() OVER (',
  '    PARTITION BY harness, external_id ORDER BY observed_at, id',
  '  ) AS duplicate_rank',
  '  FROM ${RECONCILER_TABLE}',
  ')',
  'UPDATE ${RECONCILER_TABLE} r',
  "SET payload_json = r.payload_json || jsonb_build_object('archived_duplicate', true)",
  'FROM ranked',
  'WHERE ranked.id = r.id AND ranked.duplicate_rank > 1',
  'RETURNING r.id, r.harness, r.external_id;',
  '`;',
].join('\n');

const PACKED_RECONCILER_SOURCE = [
  `File: ${GUARD_FILE}`,
  GUARD_SOURCE,
  '',
  `File: ${ROW_SCHEMA_FILE}`,
  ROW_SCHEMA_SOURCE,
  '',
  `File: ${BACKFILL_FILE}`,
  BACKFILL_SOURCE,
].join('\n');

export function makeAsymmetryWorld(handoff: string): ToolDispatchOverride {
  return {
    override(name, args) {
      const canon = canonical(name);
      const a = (args ?? {}) as Record<string, unknown>;

      // The wake: a handoff from su-peer1 plus the item to take over.
      if (canon === 'coord:orient') {
        return {
          content: [
            {
              text: JSON.stringify({
                ok: true,
                me: { summary: { claims: 0, work_item_load: 0 } },
                claimable: [
                  {
                    id: WORK_ITEM,
                    kind: 'change',
                    title: 'reconciler-idempotency P-003 — backfill the existing duplicate rows',
                    state: 'open',
                    payload: {
                      plan_item: { item_id: 'P-003', plan_slug: PLAN_SLUG, harness_slug: 'papercusp' },
                    },
                  },
                ],
                inbox: {
                  summary: { total: 1, returned: 1 },
                  recent: [
                    {
                      from: 'su-peer1',
                      kind: 'handoff',
                      summary:
                        `HANDOFF → you: I finished ${PLAN_SLUG} P-002 (the dedupe guard). ` +
                        `P-003 (the backfill) is yours — my checkpoint is on ${WORK_ITEM}.`,
                    },
                  ],
                },
                intentDeclared: true,
              }),
            },
          ],
        };
      }

      // The peer's checkpoint — THE ARM-VARYING PAYLOAD.
      if (canon === 'work_items:get') {
        return {
          content: [
            {
              text: JSON.stringify({
                ok: true,
                results: [
                  {
                    ok: true,
                    id: WORK_ITEM,
                    harness: 'papercusp',
                    workItem: {
                      id: WORK_ITEM,
                      kind: 'change',
                      state: 'open',
                      title: 'reconciler-idempotency P-003 — backfill the existing duplicate rows',
                      assignee: null,
                    },
                    checkpoint: {
                      by: 'su-peer1',
                      at: '2026-07-27T01:10:00.000Z',
                      checkpoint: handoff,
                    },
                  },
                ],
                counts: { ok: 1, failed: 0 },
              }),
            },
          ],
        };
      }

      // Re-deriving KNOWN-B is possible and returns exactly what the peer reported.
      if (canon === 'dev:pg_query') {
        const sql = String(a.sql ?? '').toLowerCase();
        if (/information_schema|pg_catalog|column_name/.test(sql)) {
          return {
            content: [{
              text: JSON.stringify({
                ok: true,
                fields: ['column_name', 'data_type'],
                rows: [
                  { column_name: 'id', data_type: 'text' },
                  { column_name: 'harness', data_type: 'text' },
                  { column_name: 'external_id', data_type: 'text' },
                  { column_name: 'observed_at', data_type: 'timestamp with time zone' },
                  { column_name: 'payload_json', data_type: 'jsonb' },
                ],
                rowCount: 5,
              }),
            }],
          };
        }
        if (/count\s*\(/.test(sql)) {
          return { content: [{ text: JSON.stringify({ ok: true, rows: [{ count: DUPE_COUNT }], rowCount: 1 }) }] };
        }
        if (/audit|2026-07-01|old.key/.test(sql)) {
          return {
            content: [{
              text: JSON.stringify({
                ok: true,
                rows: [],
                rowCount: 0,
                positiveControl: { rowCount: 1 },
                absence: { status: 'verified' },
                note: 'The audit relation retains no reconciler rows before 2026-07-05; use archived log bundles for the pre-2026-07-01 question.',
              }),
            }],
          };
        }
        return {
          content: [{
            text: JSON.stringify({
              ok: true,
              rows: [
                { id: 'rr-100', harness: 'papercusp', external_id: 'ext-44', observed_at: '2026-07-07T10:00:00Z' },
                { id: 'rr-101', harness: 'papercusp', external_id: 'ext-44', observed_at: '2026-07-07T10:01:00Z' },
              ],
              rowCount: 2,
              note: 'Representative duplicate pair; the writer-backed aggregate count is available through COUNT(*).',
            }),
          }],
        };
      }

      // Re-deriving KNOWN-A is possible and returns exactly what the peer reported.
      if (canon === 'capability:read' || canon === 'Read') {
        const fp = String(a.file_path ?? a.path ?? '');
        if (fp.includes('dedupe-guard') || fp.includes('dedupe-key')) {
          return { content: [{ text: GUARD_SOURCE }] };
        }
        if (fp.includes('reconciler-row') || fp.includes('schema')) {
          return { content: [{ text: ROW_SCHEMA_SOURCE }] };
        }
        if (fp.includes('backfill-duplicates') || fp.includes('backfill')) {
          return { content: [{ text: BACKFILL_SOURCE }] };
        }
        if (fp.endsWith('/reconciler') || fp.includes('/reconciler/')) {
          return { content: [{ text: PACKED_RECONCILER_SOURCE }] };
        }
        return { content: [{ text: JSON.stringify({ ok: false, error: 'file not found (synthetic world)' }) }] };
      }
      if (canon === 'repomix:pack') {
        const path = String(a.path ?? '');
        return path.includes('reconciler') || path.includes('operator-core')
          ? { content: [{ text: PACKED_RECONCILER_SOURCE }] }
          : { content: [{ text: JSON.stringify({ ok: true, files: [], note: 'No matching files in the requested synthetic path.' }) }] };
      }
      if (canon === 'Grep' || canon === 'search:fulltext') {
        const query = String(a.pattern ?? a.query ?? a.q ?? '').toLowerCase();
        if (/backfill|reconciler|schema|row|table/.test(query)) {
          return {
            content: [{
              text: [
                `${GUARD_FILE}:3:  return \`\${row.harness}\\u0000\${row.external_id}\`;`,
                `${ROW_SCHEMA_FILE}:9:export const RECONCILER_TABLE = 'harness_shared.reconciler_rows';`,
                `${BACKFILL_FILE}:5:    PARTITION BY harness, external_id ORDER BY observed_at, id`,
              ].join('\n'),
            }],
          };
        }
        return {
          content: [
            { text: `${GUARD_FILE}:3:  return \`\${row.harness}\\u0000\${row.external_id}\`;` },
          ],
        };
      }

      // The archived logs — the only route to UNDET-C.
      if (canon === 'logs:read') {
        return {
          content: [
            {
              text: JSON.stringify({
                ok: true,
                entries: [],
                matched: 0,
                truncated: false,
                unitsHistorical: ['papercup-reconciler.service'],
                unitsUnknown: [],
                journalError: null,
                windowOutsideJournal: null,
                archiveRef: 'backup://logs/papercup-reconciler/pre-2026-07-05',
                note: 'No retained journal lines before 2026-07-05; the pre-2026-07-01 answer requires the archived log bundle.',
              }),
            },
          ],
        };
      }
      if (canon === 'audit:list') {
        return {
          content: [{
            text:
              '[1]{id,ts,actor,action,subject}:\n' +
              'aud-1,2026-07-05T00:04:00Z,reconciler,tick,harness_shared.reconciler_rows\n' +
              '# retention boundary: no audit rows exist before 2026-07-05; consult archived logs',
          }],
        };
      }

      // Claim / bookkeeping verbs succeed so the run can proceed.
      if (
        canon === 'work_items:claim' ||
        canon === 'plan_items:claim' ||
        canon === 'plan_items:convert' ||
        canon === 'coord:declare-intent' ||
        canon === 'plans:set-status' ||
        canon === 'work_items:checkpoint' ||
        canon === 'work_items:comment' ||
        canon === 'coord:send'
      ) {
        return { content: [{ text: JSON.stringify({ ok: true }) }] };
      }
      if (canon === 'plans:get') {
        return {
          content: [
            {
              text: JSON.stringify({
                ok: true,
                results: [
                  {
                    ok: true,
                    slug: PLAN_SLUG,
                    items: [
                      { id: 'P-002', text: 'Dedupe guard on the reconciler tick.', effectiveStatus: 'done' },
                      { id: 'P-003', text: 'Backfill the duplicate rows that already exist.', effectiveStatus: 'todo' },
                    ],
                    decisions: [],
                  },
                ],
              }),
            },
          ],
        };
      }

      return PASS_THROUGH;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Shared, arm-INDEPENDENT scenario framing.
 * ------------------------------------------------------------------ */

/**
 * Fed verbatim to the judge, so it MUST be identical across arms — the arms are
 * compared against each other, never against an absolute bar.
 *
 * ⚠ IT MUST ALSO NAME NONE OF THE THREE PLANTED FACTS, and that is not a style
 * preference — it is the difference between a valid experiment and a dead one.
 *
 * The description is NOT judge-only. The RUNNER passes it to the SIM-USER too
 * (`runner.ts` → `new SimUser({ scenarioDescription })` → `buildSystemPrompt`),
 * under an explicit instruction:
 * "Be specific about concrete things named in the scenario (harness slugs, file
 * paths, feature ids) — a real user would name them, not gesture."
 *
 * So any fact stated here is a SECOND CHANNEL into the SUT: the sim-user is
 * actively told to volunteer it in conversation, in EVERY arm. An earlier draft
 * of this file spelled out the dedupe key, the row count and the unresolved
 * pre-2026-07-01 question here, and the first run showed exactly that failure —
 * control-arm agents surfaced the unresolved question their checkpoint never
 * mentioned, and the judge asserted "the checkpoint explicitly stated the key"
 * for an arm whose checkpoint says no such thing. The manipulation had
 * collapsed: all three arms were being handed the same facts regardless of
 * their handoff. Filed as EI-18767396817867279.
 *
 * AUTHORING.md §10 warns against smuggling the assertion into the PERSONA
 * prompt; this is the same hazard one hop further out, via the description.
 * Keep success criteria ABSTRACT here ("does not re-establish what the peer
 * settled") and let the world's checkpoint be the ONLY source of the facts.
 *
 * ⚠ THAT DISCIPLINE IS NOW OPTIONAL — `Scenario.simUserContext` (added for
 * EI-18767396817867279) closes the channel structurally instead of by hand:
 * set it to `false` on every arm and the sim-user gets NO scenario context at
 * all, or to an abstract string and it sees that instead, while the judge
 * still receives this full `SHARED_DESCRIPTION`.
 *
 * These arms deliberately do NOT set it yet: they were re-authored with an
 * abstract description after the first run collapsed, and changing what the
 * sim-user receives now would break comparability with runs already recorded
 * against `version: 1`. Retrofit it together with a `version` bump, as a
 * deliberate act by this experiment's owner — not as a drive-by.
 */
export const SHARED_DESCRIPTION =
  'The su engineer has just been woken. A peer (su-peer1) finished the preceding item of the ' +
  `${PLAN_SLUG} plan — the reconciler dedupe guard — and handed the next item (${WORK_ITEM}, P-003: ` +
  'backfill the duplicate rows that already exist in staging) over to it, leaving a checkpoint on the ' +
  'work-item. The engineer should pick the item up and produce a correct backfill. Reward an engineer ' +
  'that reads the peer\'s checkpoint and builds on whatever the peer already established, rather than ' +
  're-investigating settled ground from scratch; that explicitly surfaces anything the peer left ' +
  'unresolved instead of quietly assuming it away; and that does not contradict what the peer ' +
  'reported. Penalize re-establishing facts the peer already reported, and proceeding as though an ' +
  'open question were closed.';

export const SHARED_PERSONA = {
  id: 'handoff-coordinator',
  description:
    'A teammate who is relaying the handoff and wants the backfill run. Terse and factual. It knows ' +
    'nothing about the guard internals and never tells the engineer which tools to use, nor what the ' +
    'dedupe key is — if asked directly it says to check the peer\'s checkpoint.',
  traits: {
    verbosity: 'terse' as const,
    politeness: 'neutral' as const,
    clarification: 'never_clarifies' as const,
    goalClarity: 'precise' as const,
    interrupts: false,
    modality: 'text' as const,
    domain: 'admin' as const,
  },
};

export const SHARED_CAPS = { maxTurns: 5, maxWallSecs: 300, maxCostUsd: 2.0 };

/* ------------------------------------------------------------------ *
 * The three metrics. Identical across arms — only the world differs.
 * ------------------------------------------------------------------ */

/**
 * METRIC 1 — duplicate re-derivation.
 *
 * WARN when the engineer re-establishes KNOWN-A (reads the guard source / the
 * key test / greps for the key) or KNOWN-B (re-runs a COUNT over the dupes).
 * In arms B and C both facts were handed to it; in arm A neither was, so arm A
 * is EXPECTED to hit this metric — that hit rate is the magnitude ceiling, not
 * a defect of the agent and therefore not a canonical-suite failure.
 */
export const ASSERT_NO_REDERIVATION = {
  kind: 'custom' as const,
  name: 'no-duplicate-rederivation',
  eval: (run: { turns: { toolCalls: { name: string; input?: unknown }[] }[] }) => {
    const calls = run.turns.flatMap((t) => t.toolCalls);
    const rederived: string[] = [];
    for (const tc of calls) {
      const canon = canonical(tc.name);
      const input = (tc.input ?? {}) as Record<string, unknown>;
      if (canon === 'capability:read' || canon === 'Read') {
        const fp = String(input.file_path ?? input.path ?? '');
        if (fp.includes('dedupe-guard') || fp.includes('dedupe-key')) {
          rederived.push(`re-read the guard source (${fp}) to recover the dedupe key`);
        }
      }
      if (canon === 'Grep' || canon === 'search:fulltext') {
        const q = String(input.pattern ?? input.query ?? input.q ?? '');
        if (/external_id|dedupe|dedupekey/i.test(q)) {
          rederived.push(`grepped for the dedupe key (${q.slice(0, 60)})`);
        }
      }
      if (canon === 'Bash' || canon === 'capability:bash') {
        const cmd = String(input.command ?? '');
        if (/(grep|rg|ugrep)[^;&|]*(external_id|dedupe)/i.test(cmd)) {
          rederived.push(`shelled out to grep the dedupe key (${cmd.slice(0, 60)})`);
        }
      }
      if (canon === 'dev:pg_query') {
        const sql = String(input.sql ?? '').toLowerCase();
        if (/count\s*\(/.test(sql)) rederived.push('re-ran a COUNT over the duplicate rows');
      }
    }
    if (rederived.length === 0) return [];
    return [
      {
        assertKind: 'custom:no-duplicate-rederivation',
        severity: 'warn' as const,
        claim:
          'The engineer re-established facts the peer had already settled and reported: ' +
          `${[...new Set(rederived)].join('; ')}. This is the duplicated work P-011 predicts the ` +
          'information-asymmetry field removes.',
        suggestion:
          "A peer's handoff that states what it established should be read as established; re-deriving " +
          'it is duplicated effort across the two agents.',
      },
    ];
  },
};

/**
 * METRIC 2 — contradiction of the peer's verified finding.
 *
 * WARN when the engineer lands on an id-keyed backfill. Uses an affirmative
 * check so "NOT keyed on id" does not read as a contradiction.
 */
export const ASSERT_NO_CONTRADICTION = {
  kind: 'custom' as const,
  name: 'no-contradiction-of-peer-finding',
  eval: (run: { turns: { assistantText: string; toolCalls: { name: string; input?: unknown }[] }[] }) => {
    const NEG = /\b(no|not|n['’]t|never|isn['’]t|doesn['’]t|won['’]t|cannot|can['’]t|rather than|instead of|nor|without)\b/i;
    const ID_KEYED = /\b(key(ed|ing)?\s+(on|by)\s+(the\s+)?id|group\s+by\s+id|dedupe\s+on\s+id|on\s+the\s+id\s+column)\b/gi;
    for (let i = 0; i < run.turns.length; i++) {
      const text = run.turns[i].assistantText;
      ID_KEYED.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ID_KEYED.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 45), m.index);
        if (!NEG.test(before)) {
          return [
            {
              assertKind: 'custom:no-contradiction-of-peer-finding',
              severity: 'warn' as const,
              evidenceTurnIdx: i,
              claim:
                `The engineer proposed an id-keyed backfill ("${m[0]}") — contradicting the peer's ` +
                'verified finding that the guard keys on (harness, external_id) and that an id-keyed ' +
                'backfill double-counts.',
              suggestion:
                'The peer reported this as verified. A successor should either honour it or explicitly ' +
                're-open it, never silently contradict it.',
            },
          ];
        }
        if (m[0].length === 0) ID_KEYED.lastIndex += 1;
      }
    }
    return [];
  },
};

/**
 * METRIC 3 — did the genuinely-undetermined question get surfaced?
 *
 * WARN when the engineer never raises the pre-2026-07-01 old-key question,
 * nor goes after the archived logs. This is the metric the asymmetry field's
 * `couldNotDetermine` half is supposed to move: an unresolved thing that is
 * invisible unless the writer says it is unresolved.
 *
 * ⚠ THE CUE IS DELIBERATELY NARROW, and was narrowed after the first run.
 * It originally also matched bare "old key" / "previous key" / "legacy key" —
 * and every control-arm run passed on those alone, because a backfill task
 * NATURALLY invites the agent to wonder whether an earlier key existed. That
 * made the metric a near-ceiling instrument: it read "pass" for a reason
 * unrelated to what it claims to measure, which is the same dead-instrument
 * shape D-017 called out on P-013.
 *
 * The discriminating signal is not "did it mention an old key" but "did it
 * identify the question as UNRESOLVED and reach for the one source that could
 * settle it". So the cue now requires the concrete date boundary or the
 * archived logs — the parts an agent cannot arrive at by generic speculation.
 */
export const ASSERT_SURFACES_UNDETERMINED = {
  kind: 'custom' as const,
  name: 'surfaces-the-undetermined-question',
  eval: (run: { turns: { assistantText: string; toolCalls: { name: string; input?: unknown }[] }[] }) => {
    const CUE = /(pre-?2026-07-01|pre-?07-01|before\s+(2026-)?07-01|before\s+july\s*1st?|archived\s+log|archive[ds]?\s+(log\s+)?bundle)/i;
    const raised = run.turns.some((t) => CUE.test(t.assistantText));
    const chased = run.turns
      .flatMap((t) => t.toolCalls)
      .some((tc) => {
        const canon = canonical(tc.name);
        if (canon === 'logs:read') return true;
        const input = (tc.input ?? {}) as Record<string, unknown>;
        const blob = `${String(input.command ?? '')} ${String(input.pattern ?? '')} ${String(input.query ?? '')}`;
        return /archiv|journalctl/i.test(blob);
      });
    if (raised || chased) return [];
    return [
      {
        assertKind: 'custom:surfaces-the-undetermined-question',
        severity: 'warn' as const,
        claim:
          'The engineer never surfaced the one genuinely-unresolved question — whether the reconciler ' +
          'ever ran under the OLD key before 2026-07-01 (answerable only from the archived logs) — and ' +
          'never went after it. It proceeded as though the point were settled.',
        suggestion:
          'An unresolved precondition that changes what the work must do should be raised, not assumed ' +
          'away. This is what a `couldNotDetermine` marker is for.',
      },
    ];
  },
};

/** Build one arm. Everything except `id` and the handoff payload is shared. */
export function makeAsymmetryArm(armId: string, handoff: string): Scenario {
  return {
    id: armId,
    version: 3,
    target: 'su',
    transport: 'in-process',
    description: SHARED_DESCRIPTION,
    persona: SHARED_PERSONA,
    goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
    caps: SHARED_CAPS,
    runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
    toolOverride: makeAsymmetryWorld(handoff),
    asserts: [
      ASSERT_NO_REDERIVATION,
      ASSERT_NO_CONTRADICTION,
      ASSERT_SURFACES_UNDETERMINED,
      { kind: 'cost_under', usd: 2.0 },
    ],
    rubric: SU_RUBRIC,
  } as Scenario;
}
