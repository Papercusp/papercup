#!/usr/bin/env node
/**
 * check-plane-producers.mjs — THE PRODUCER CENSUS
 * (agent-state-plane-verification-2026-07-27 P-001).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The unified agent-state plane shipped 33 items with green unit tests and then
 * produced EIGHT defects that unit tests could not see. Every one was the same
 * shape: a field, column or channel that is DECLARED and VALIDATED at one end and
 * REACHED BY NOTHING at the other.
 *
 *   · WI-6444 — `unknownHoist` declared on 6 cells, enforced at registration,
 *     emitted by zero readers. Six declaration sites, one validator, no consumer.
 *   · WI-6465 — the mirror image: `kind='assumption'`, `depends_on` and `claim`
 *     have consumers (P-011's detector, P-009's stamp, P-024's read) and ZERO
 *     producers. 0 rows of 2,180, all time.
 *
 * A unit test cannot catch either, because both halves are individually correct.
 * The defect lives in the JOIN between them, and the join only exists in
 * production data. So this gate asks the one question the type system cannot:
 *
 *     For every field this plane added — is anything actually WRITING it?
 *
 * ── ⚠ THE VACUOUS PASS THIS GATE IS BUILT TO AVOID ──────────────────────────
 *
 * The obvious implementation reports `populated` per field and fails on zero.
 * That gate is WRONG in the most dangerous direction, because two completely
 * different situations both produce `populated = 0`:
 *
 *   (a) the table holds 170,000 rows and none carry the field  → NO PRODUCER.
 *       A real defect, and exactly WI-6465.
 *   (b) the table is EMPTY (fresh database, pruned window, new install)
 *                                                              → NO DATA.
 *       Says nothing at all about the producer.
 *
 * Reporting (b) as a failure trains everyone to ignore the gate on a fresh box;
 * reporting it as a PASS is the vacuous pass — a green tick that means "we looked
 * at nothing". Both are worse than useless. So `judgeProducerField` returns THREE
 * verdicts and `no-data` is neither pass nor fail: it is `unknown`, reported
 * separately and loudly, exactly as `cell-contract.ts` reserves an enumerated
 * unknown rather than collapsing it into a boolean.
 *
 * This mirrors what P-015's own measurement module already learned the hard way:
 * a metric with no input must report `interpretable: false`, never a clean zero.
 * The whole reason WI-6465 was FINDABLE is that P-015 refused to round its zero
 * up to a pass. This gate inherits that rule rather than re-deriving it.
 *
 * ── HOW TO ADD A FIELD ──────────────────────────────────────────────────────
 *
 * Append to {@link PLANE_PRODUCER_FIELDS}. Every entry MUST carry `why` (what
 * breaks if nothing writes it) and `producer` (the act that is supposed to write
 * it) — a field whose producer nobody can name is a field nobody owns, which is
 * the condition that produced WI-6465.
 */

import os from 'node:os';
import { readFileSync } from 'node:fs';

/**
 * THE CENSUS. One row per field this plane added.
 *
 * `sinceDays` is per-field on purpose. A stamp written on every dispatch is
 * expected within hours, so a 7-day window that finds nothing is damning. A fact
 * modality written a few times a week needs a longer window before silence means
 * anything — and using one global window would either make the slow fields
 * flap or let the fast ones stay dead for a week unnoticed.
 */
export const PLANE_PRODUCER_FIELDS = [
  {
    id: 'tool_invocations.intent_event_id',
    table: 'harness_shared.tool_invocations',
    column: 'intent_event_id',
    tsColumn: 'invoked_at',
    sinceDays: 1,
    producer: "P-009 stamp writer ← coord:declare-intent / coord:orient { intent }",
    why: "P-010's divergence detector buckets calls by this id. With no stamp there are no buckets, and the detector reports a clean zero for the same reason a perfectly-disciplined fleet would.",
  },
  {
    id: 'tool_invocations.goal_ref',
    table: 'harness_shared.tool_invocations',
    column: 'goal_ref',
    tsColumn: 'invoked_at',
    sinceDays: 1,
    producer: 'P-009 stamp writer ← work_items:claim / release (noteGoalClaimed)',
    why: 'P-024\'s "what did this agent do while holding goal X" read filters on it. Unstamped calls are invisible to every postmortem.',
  },
  {
    id: 'tool_invocations.assumption_set_id',
    table: 'harness_shared.tool_invocations',
    column: 'assumption_set_id',
    tsColumn: 'invoked_at',
    sinceDays: 7,
    producer: 'P-009 stamp writer ← facts:assert { kind:"assumption" } (noteAssumptionAsserted)',
    why: 'ACCEPTED ZERO BY RULING (D-102 F3 + D-103), not a queued gap. Structurally always-NULL while no assumption facts exist — and D-102 F3 measured `kind` and REFUSED to force it, because agents honestly assert verified conclusions, so forcing would yield "conclusion" and leave this exactly as null at fleet-wide friction cost. P-024 therefore cannot resolve an assumption set behind any historical call, and that is the ruled outcome rather than pending work.',
    knownUnbuilt: 'D-103 (ruled)',
  },
  {
    id: 'agent_facts.kind',
    table: 'harness_shared.agent_facts',
    column: 'kind',
    tsColumn: 'created_at',
    sinceDays: 30,
    producer: 'facts:assert { kind } — OPT-IN, no default',
    why: 'The modality split (conclusion | assumption | convention). Without it every fact is an undifferentiated blob and P-008\'s whole taxonomy is decorative.',
  },
  {
    id: "agent_facts.kind='assumption'",
    table: 'harness_shared.agent_facts',
    column: 'kind',
    predicate: "kind = 'assumption'",
    tsColumn: 'created_at',
    sinceDays: 30,
    producer: 'facts:assert { kind:"assumption" }',
    why: "ACCEPTED ZERO BY RULING (D-102 F3 + D-103). The consumer this row used to name — P-011's conflicting-assumption detector — was RETIRED by WI-6545/D-103, so the old rationale is void. What still reads the modality is the P-009 assumption watermark (`isAssumptionFact` in agent-facts/store.ts), which simply never moves. D-102 F3 refused to force `kind`, so 0 here is the ruled outcome, not pending work.",
    knownUnbuilt: 'D-103 (ruled)',
  },
  {
    id: 'agent_facts.depends_on',
    table: 'harness_shared.agent_facts',
    column: 'depends_on',
    predicate: "depends_on IS NOT NULL AND depends_on::text <> '[]'",
    tsColumn: 'created_at',
    sinceDays: 30,
    producer: 'facts:assert { dependsOn } → captureFactDependencies',
    why: "WI-6465. D-007 auto-invalidation is what makes an assumption more than a weak-badged conclusion. With no dependsOn nothing can ever go stale on its own terms, and `acted-on-stale-or-wrong-value` is permanently uninterpretable.",
    knownUnbuilt: 'WI-6465',
  },
  {
    id: 'agent_facts.claim',
    table: 'harness_shared.agent_facts',
    column: 'claim',
    tsColumn: 'created_at',
    sinceDays: 30,
    producer: 'facts:assert { claim }',
    why: "WI-6465. The typed assertion P-011's contradiction detector compares. Prose cannot be branched on — that is the entire argument of cell-contract.ts, applied to facts.",
    knownUnbuilt: 'WI-6465',
  },
  {
    id: 'agent_facts.enforcement',
    table: 'harness_shared.agent_facts',
    column: 'enforcement',
    tsColumn: 'created_at',
    sinceDays: 30,
    producer: 'facts:assert { kind:"convention", enforcement }',
    why: "P-017/D-016: a convention with no declared tier is prose exhortation in a costume. Measured 5 of 30 conventions at audit time.",
  },
];

/** Verdicts. `no-data` is deliberately NEITHER pass nor fail — see the header. */
export const PRODUCER_VERDICTS = ['producing', 'no-producer', 'no-data'];

/**
 * Judge one census row. Pure ({ populated, total } -> verdict) so the
 * distinction this gate exists to make is unit-testable with no database.
 *
 * ⚠ `total === 0` MUST NOT be a pass and MUST NOT be a failure. It is the "we
 * looked at nothing" case, and conflating it with either direction is precisely
 * the vacuous pass documented in the header.
 */
export function judgeProducerField({ populated, total }) {
  if (!Number.isFinite(total) || total <= 0) return 'no-data';
  if (!Number.isFinite(populated) || populated <= 0) return 'no-producer';
  return 'producing';
}

/** Fill ratio, or null when there is no denominator to divide by. */
export function fillRate({ populated, total }) {
  if (!Number.isFinite(total) || total <= 0) return null;
  return populated / total;
}

/**
 * Roll a judged census up into an exit decision.
 *
 * A field with a `knownUnbuilt` ref is reported but does NOT fail the gate: the
 * defect is already filed and owned, and re-failing the build for a known-open
 * bug turns the gate into noise the fleet routes around (which is how the
 * no-bespoke-state-read gate nearly died — WI-6464). It flips to a hard failure
 * the moment its ref closes; that transition is P-003's job.
 */
export function rollupCensus(rows) {
  const noProducer = rows.filter((r) => r.verdict === 'no-producer');
  return {
    producing: rows.filter((r) => r.verdict === 'producing').length,
    noData: rows.filter((r) => r.verdict === 'no-data').length,
    knownUnbuilt: noProducer.filter((r) => r.knownUnbuilt).length,
    // Only an UNEXPLAINED dead producer fails the build.
    failures: noProducer.filter((r) => !r.knownUnbuilt),
  };
}

function resolvePgUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const p = JSON.parse(readFileSync(`${os.homedir()}/.papercusp/embedded-pg.json`, 'utf8'));
    if (p?.host && p?.port && p.user && p.password) {
      return `postgresql://${p.user}:${p.password}@${p.host}:${p.port}/papercusp`;
    }
  } catch {
    /* no discovery file — fall through to the dev default */
  }
  return 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
}

async function main() {
  const postgres = (await import('postgres')).default;
  const sql = postgres(resolvePgUrl(), { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });

  const rows = [];
  try {
    for (const f of PLANE_PRODUCER_FIELDS) {
      const predicate = f.predicate ?? `${f.column} IS NOT NULL`;
      // Identifiers cannot be parameterised; they are all literals in this file,
      // never user input. The WINDOW is parameterised.
      const [r] = await sql.unsafe(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE ${predicate})::int AS populated
           FROM ${f.table}
          WHERE ${f.tsColumn} > now() - ($1 || ' days')::interval`,
        [String(f.sinceDays)],
      );
      const populated = r?.populated ?? 0;
      const total = r?.total ?? 0;
      rows.push({ ...f, populated, total, rate: fillRate({ populated, total }), verdict: judgeProducerField({ populated, total }) });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  const roll = rollupCensus(rows);
  const pct = (r) => (r.rate === null ? '   —  ' : `${(r.rate * 100).toFixed(2).padStart(6)}%`);
  const mark = { producing: '✓', 'no-producer': '✗', 'no-data': '?' };

  console.log('\nPRODUCER CENSUS — agent-state plane (P-001)\n');
  for (const r of rows) {
    console.log(`  ${mark[r.verdict]} ${r.id.padEnd(38)} ${String(r.populated).padStart(8)}/${String(r.total).padEnd(9)} ${pct(r)}  ${r.sinceDays}d`);
    if (r.verdict === 'no-producer') {
      console.log(`      producer: ${r.producer}`);
      console.log(`      breaks:   ${r.why}`);
      if (r.knownUnbuilt) console.log(`      KNOWN:    ${r.knownUnbuilt} — reported, not failing the build`);
    }
    if (r.verdict === 'no-data') {
      console.log(`      no rows in the ${r.sinceDays}d window — this says NOTHING about the producer, and is deliberately not a pass.`);
    }
  }
  console.log(
    `\n  ${roll.producing} producing · ${roll.failures.length} DEAD · ${roll.knownUnbuilt} known-unbuilt · ${roll.noData} no-data\n`,
  );

  if (roll.failures.length > 0) {
    console.error('✗ producer census: a field this plane added is written by NOTHING, and no open item explains it.\n');
    for (const f of roll.failures) console.error(`    ${f.id} — expected producer: ${f.producer}`);
    console.error(
      '\n  This is the WI-6444/WI-6465 defect class: a declared field with no live writer.\n' +
        '  Either wire the producer, or file the gap and add its ref as `knownUnbuilt` so the\n' +
        '  census reports it instead of failing — but do NOT delete the row to green the gate.\n',
    );
    process.exitCode = 1;
    return;
  }
  console.log('✓ every field this plane added has a live producer (or a filed, owned gap).\n');
}

// Only run when invoked directly — the predicates above are imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('producer census failed to run:', err?.message ?? err);
    process.exitCode = 1;
  });
}
