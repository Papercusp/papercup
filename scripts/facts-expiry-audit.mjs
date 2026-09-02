#!/usr/bin/env node
/**
 * facts-expiry-audit.mjs — WI-2141854.
 *
 * Agents supplied `ttlSec: null` to facts:assert, which defaults to a 7-day TTL, so
 * durable standing conclusions silently lapsed out of every brief/orient fold. This
 * script is the restoration half: it DUMPS the lapsed population for per-fact audit,
 * and APPLIES the audited verdicts back as a direct `expires_at` UPDATE.
 *
 * Why a direct UPDATE and not facts:assert — assert SUPERSEDES the row (new version,
 * new created_by = the restoring agent, new created_at, TTL capped at 90d). That
 * destroys exactly the provenance an audit exists to preserve. Unexpiring is an
 * expiry-field correction on the SAME row, so the author, the assertion time and the
 * version chain all survive.
 *
 * The lapsed population is defined by the fold predicate itself
 * (store.ts liveFactPredicate): a fold serves rows where
 *   superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()
 * so the only rows that EXPIRY (rather than supersession or retraction) removed are
 *   expires_at <= now() AND superseded_at IS NULL AND retracted_at IS NULL.
 *
 * Usage:
 *   node scripts/facts-expiry-audit.mjs dump   --out <dir>
 *   node scripts/facts-expiry-audit.mjs apply  --verdicts <jsonl> [--execute]
 *   node scripts/facts-expiry-audit.mjs verify --verdicts <jsonl>
 *
 * `apply` is DRY-RUN unless --execute is passed.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { connectScriptPg } from './lib/pg-url.mjs';

const LAPSED_PREDICATE = `expires_at <= now() AND superseded_at IS NULL AND retracted_at IS NULL`;

/** Permanent-expiry sentinel — FACT_PERMANENT_EXPIRY in agent-facts/store.ts. */
const PERMANENT = 'infinity';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function cmdDump() {
  const outDir = String(arg('out', 'tmp/facts-expiry-audit'));
  mkdirSync(outDir, { recursive: true });
  const client = await connectScriptPg();
  try {
    const { rows } = await client.query(`
      SELECT id, workspace_id, scope, scope_ref, key, body, source_ref, created_by,
             created_at::text AS created_at, updated_at::text AS updated_at,
             expires_at::text AS expires_at, kind, confidence, audience_scope,
             settled_by, origin, source_hive,
             (measurement IS NOT NULL) AS has_measurement,
             (recheck IS NOT NULL) AS has_recheck,
             (depends_on IS NOT NULL) AS has_depends_on,
             (enforcement IS NOT NULL) AS has_enforcement
        FROM harness_shared.agent_facts
       WHERE ${LAPSED_PREDICATE}
       ORDER BY scope, coalesce(scope_ref,''), key, id`);

    const jsonl = rows.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(join(outDir, 'lapsed-facts.jsonl'), jsonl + '\n');

    // A compact per-fact review line: everything a verdict needs, nothing else.
    const compact = rows
      .map((r) => {
        const flags = [
          r.kind ? `k=${r.kind}` : '',
          r.confidence ? `c=${r.confidence}` : '',
          r.has_measurement ? 'MEAS' : '',
          r.has_recheck ? 'RECHK' : '',
          r.has_depends_on ? 'DEPS' : '',
          r.settled_by ? 'SETTLED' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const body = String(r.body ?? '').replace(/\s+/g, ' ').trim();
        return `#${r.id}\t${r.scope}:${r.scope_ref ?? ''}\t${r.key}\t[${flags}]\tby=${r.created_by}\texp=${String(r.expires_at).slice(0, 10)}\t${body}`;
      })
      .join('\n');
    writeFileSync(join(outDir, 'lapsed-facts.tsv'), compact + '\n');

    console.log(`DUMPED\t${rows.length}\t${outDir}`);
    console.log(`BODY_CHARS\t${rows.reduce((a, r) => a + String(r.body ?? '').length, 0)}`);
  } finally {
    await client.end();
  }
}

/**
 * Read a verdict ledger. One JSON object per line:
 *   { id, verdict: 'restore'|'restore-bounded'|'leave', reason, ttlDays? }
 * `restore` sets expires_at = 'infinity'; `restore-bounded` sets now() + ttlDays.
 */
function readVerdicts(path) {
  const seen = new Map();
  const dupes = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (!t || t.startsWith('//')) continue;
    let v;
    try {
      v = JSON.parse(t);
    } catch {
      throw new Error(`verdict ledger ${path}:${i + 1} is not JSON: ${t.slice(0, 120)}`);
    }
    if (typeof v.id !== 'number' && typeof v.id !== 'string') {
      throw new Error(`verdict ledger ${path}:${i + 1} has no id`);
    }
    if (!['restore', 'restore-bounded', 'leave'].includes(v.verdict)) {
      throw new Error(`verdict ledger ${path}:${i + 1} bad verdict ${JSON.stringify(v.verdict)}`);
    }
    if (!v.reason) throw new Error(`verdict ledger ${path}:${i + 1} has no reason`);
    if (v.verdict === 'restore-bounded' && !(Number(v.ttlDays) > 0)) {
      throw new Error(`verdict ledger ${path}:${i + 1} restore-bounded needs ttlDays > 0`);
    }
    const id = Number(v.id);
    if (seen.has(id)) dupes.push(id);
    seen.set(id, { ...v, id });
  }
  return { verdicts: seen, dupes };
}

/**
 * Coverage is the whole point of the audit: refuse to apply a ledger that does not
 * carry a verdict for EVERY lapsed row, and refuse one carrying verdicts for rows
 * that are not in the population (a stale id is a sign the ledger drifted).
 */
async function loadPopulation(client) {
  const { rows } = await client.query(
    `SELECT id FROM harness_shared.agent_facts WHERE ${LAPSED_PREDICATE}`,
  );
  return new Set(rows.map((r) => Number(r.id)));
}

async function cmdApply() {
  const path = String(arg('verdicts'));
  const execute = arg('execute') === true;
  const allowPartial = arg('allow-partial') === true;
  if (!path || !existsSync(path)) throw new Error(`--verdicts <jsonl> required (got ${path})`);
  const { verdicts, dupes } = readVerdicts(path);
  if (dupes.length) {
    throw new Error(`verdict ledger has ${dupes.length} duplicate ids, e.g. ${dupes.slice(0, 5)}`);
  }

  const client = await connectScriptPg();
  try {
    const population = await loadPopulation(client);
    const missing = [...population].filter((id) => !verdicts.has(id));
    const unknown = [...verdicts.keys()].filter((id) => !population.has(id));

    console.log(`POPULATION\t${population.size}`);
    console.log(`VERDICTS\t${verdicts.size}`);
    console.log(`UNJUDGED\t${missing.length}`);
    console.log(`NOT_IN_POPULATION\t${unknown.length}`);

    if (unknown.length) {
      // An id already restored by a previous --execute run leaves the population, so
      // a re-run is expected to report these. Anything else means ledger drift.
      console.log(`NOT_IN_POPULATION_SAMPLE\t${unknown.slice(0, 10).join(',')}`);
    }
    if (missing.length && !allowPartial) {
      console.log(`UNJUDGED_SAMPLE\t${missing.slice(0, 20).join(',')}`);
      throw new Error(
        `REFUSED: ${missing.length} lapsed facts carry no verdict. The audit must cover every ` +
          `row. Pass --allow-partial only for a deliberate staged batch.`,
      );
    }

    const restore = [];
    const bounded = [];
    for (const id of population) {
      const v = verdicts.get(id);
      if (!v) continue;
      if (v.verdict === 'restore') restore.push(id);
      else if (v.verdict === 'restore-bounded') bounded.push([id, Number(v.ttlDays)]);
    }
    const leave = population.size - restore.length - bounded.length - missing.length;
    console.log(`PLAN_RESTORE_PERMANENT\t${restore.length}`);
    console.log(`PLAN_RESTORE_BOUNDED\t${bounded.length}`);
    console.log(`PLAN_LEAVE\t${leave}`);

    if (!execute) {
      console.log('DRY_RUN — nothing written. Re-run with --execute to apply.');
      return;
    }

    await client.query('BEGIN');
    let n = 0;
    if (restore.length) {
      const r = await client.query(
        `UPDATE harness_shared.agent_facts
            SET expires_at = $2::timestamptz, updated_at = now()
          WHERE id = ANY($1::bigint[]) AND ${LAPSED_PREDICATE}`,
        [restore, PERMANENT],
      );
      n += r.rowCount;
      console.log(`APPLIED_PERMANENT\t${r.rowCount}`);
    }
    // Group bounded restores by ttlDays so each distinct horizon is one statement.
    const byTtl = new Map();
    for (const [id, days] of bounded) {
      if (!byTtl.has(days)) byTtl.set(days, []);
      byTtl.get(days).push(id);
    }
    for (const [days, ids] of byTtl) {
      const r = await client.query(
        `UPDATE harness_shared.agent_facts
            SET expires_at = now() + ($2::int * interval '1 day'), updated_at = now()
          WHERE id = ANY($1::bigint[]) AND ${LAPSED_PREDICATE}`,
        [ids, days],
      );
      n += r.rowCount;
      console.log(`APPLIED_BOUNDED_${days}d\t${r.rowCount}`);
    }
    await client.query('COMMIT');
    console.log(`APPLIED_TOTAL\t${n}`);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the txn may never have opened */
    }
    throw err;
  } finally {
    await client.end();
  }
}

async function cmdVerify() {
  const path = String(arg('verdicts'));
  const { verdicts } = readVerdicts(path);
  const wanted = [...verdicts.values()].filter((v) => v.verdict !== 'leave').map((v) => v.id);
  const client = await connectScriptPg();
  try {
    const { rows } = await client.query(
      `SELECT count(*) FILTER (WHERE expires_at > now()) AS live,
              count(*) FILTER (WHERE expires_at = 'infinity') AS permanent,
              count(*) FILTER (WHERE expires_at <= now()) AS still_expired,
              count(*) FILTER (WHERE retracted_at IS NOT NULL) AS retracted,
              count(*) FILTER (WHERE superseded_at IS NOT NULL) AS superseded,
              count(*) AS total
         FROM harness_shared.agent_facts WHERE id = ANY($1::bigint[])`,
      [wanted],
    );
    console.log(`EXPECTED_RESTORED\t${wanted.length}`);
    console.log(JSON.stringify(rows[0]));
    const { rows: pop } = await client.query(
      `SELECT count(*) AS remaining_lapsed FROM harness_shared.agent_facts WHERE ${LAPSED_PREDICATE}`,
    );
    console.log(`REMAINING_LAPSED\t${pop[0].remaining_lapsed}`);
  } finally {
    await client.end();
  }
}

const cmd = process.argv[2];
const run =
  cmd === 'dump' ? cmdDump : cmd === 'apply' ? cmdApply : cmd === 'verify' ? cmdVerify : null;
if (!run) {
  console.error('usage: facts-expiry-audit.mjs <dump|apply|verify> [...]');
  process.exit(2);
}
run().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
