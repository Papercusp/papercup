/**
 * TEMPORARY one-off measurement (not a test — delete after use).
 *
 * Isolates the TRUE latency cost of LEXICAL_MAX_TOKENS 12 -> 32 on the LIVE store.
 * The lexical leg is embed-free, so this has ZERO dependency on the embedding
 * provider — which is the confound in the run-6 bench p50 (the two backends were
 * benched in different time windows while the account pool was 4/8 sustained-limited).
 */
import { benchPgClient } from './bench-host.js';
import goldSet from './fixtures/gold-set.v1.json' assert { type: 'json' };

const SCHEMA = 'harness_shared';

function lexicalTokens(q: string, cap: number): string[] {
  const raw = q.toLowerCase().match(/[a-z0-9_\-]{2,}/g) ?? [];
  const out: string[] = [];
  for (const t of raw) {
    out.push(t);
    if (/[_\-]/.test(t)) for (const sub of t.split(/[_\-]/)) if (sub.length >= 2) out.push(sub);
  }
  return [...new Set(out)].slice(0, cap);
}

async function timeQuery(client: any, q: string, cap: number): Promise<number> {
  const tokens = lexicalTokens(q, cap);
  if (!tokens.length) return 0;
  const params: any[] = [];
  let idx = 1;
  const scoreTerms = tokens.map((t) => {
    params.push(`%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const p = `$${idx++}`;
    return `CASE WHEN payload->>'name' ILIKE ${p} THEN 3 WHEN payload->>'description' ILIKE ${p} THEN 2 WHEN payload->>'data' ILIKE ${p} THEN 1 ELSE 0 END`;
  });
  params.push(10);
  const sql = `SELECT id, (${scoreTerms.join(' + ')})::float AS lex_raw
     FROM ${SCHEMA}.memory_canonical
     WHERE invalid_at IS NULL AND superseded_by IS NULL
     ORDER BY lex_raw DESC LIMIT $${idx}`;
  const t0 = performance.now();
  await client.query(sql, params);
  return performance.now() - t0;
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function main() {
  const client = await benchPgClient();
  const queries: string[] = (goldSet as any).queries.map((q: any) => q.query ?? q.q ?? q.text);
  const rows = await client.query(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.memory_canonical WHERE invalid_at IS NULL AND superseded_by IS NULL`,
  );
  console.log(`live active rows: ${rows.rows[0].n} · gold queries: ${queries.length}\n`);

  for (const cap of [12, 32]) {
    const lat: number[] = [];
    const toks: number[] = [];
    for (const q of queries) {
      toks.push(lexicalTokens(q, cap).length);
      lat.push(await timeQuery(client, q, cap));
    }
    console.log(
      `cap ${String(cap).padStart(2)} | lexical-leg p50 ${pct(lat, 50).toFixed(1)}ms · p95 ${pct(lat, 95).toFixed(1)}ms · max ${Math.max(...lat).toFixed(1)}ms | mean tokens ${(toks.reduce((a, b) => a + b, 0) / toks.length).toFixed(1)}`,
    );
  }
  await client.end();
}

void main();
