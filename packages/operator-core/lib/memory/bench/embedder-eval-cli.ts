/**
 * Embedder-quality gate CLI (shared-embedding-sidecar-and-enrichment-2026-07-10, P-001).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/embedder-eval-cli.ts \
 *     [--legs gemma,local,openai] [--sidecar http://127.0.0.1:PORT] \
 *     [--dims 384] [--out <path.json>]
 *
 * Scores embedders head-to-head on the FROZEN gold-set fixture (corpus.v1 +
 * gold-set.v1) — same corpus, same queries, same metrics; the ONLY variable is
 * which embedder produced the vectors. This is the permanent quality gate for
 * ANY embedder/runtime/model change (a different runtime, quantization, or
 * model is a DIFFERENT SPACE — see agent-insights/embedding-space-vs-dimension):
 * adopt a candidate only on a win OUTSIDE noise here, never on a leaderboard delta.
 *
 * Self-contained on purpose: no PG, no mem0 seeding, no LLM judge — it isolates
 * EMBEDDING quality from backend/judge variance (contrast: bench-cli.ts / judged-cli.ts,
 * which benchmark whole memory BACKENDS). First measured run 2026-07-10:
 * gemma@384 R@1 .808 / R@3 .942 / MRR .868 vs BGE-local .767/.875/.827 on the
 * 120 answerable queries; OpenAI leg blocked (insufficient_quota).
 *
 * Metrics per leg:
 *  - answerable queries (lexical-gap, exact-identifier, session-start-intent):
 *    recall@1/3/5 + MRR@10, overall and per class.
 *  - hard-negative queries (expected=[], topic grep-verified absent from the
 *    corpus): these are CORRECT-REJECTION probes, so recall is undefined —
 *    reported instead as the REJECTION MARGIN: top1 cosine on hard-negatives
 *    vs top1 cosine on answerable queries (bigger gap = a downstream threshold
 *    can separate "real hit" from "confident-looking noise").
 *  - wall-clock embed throughput (the corpus/doc pass and the query pass).
 *
 * Gemma's asymmetric task prompts are honored via buildGemmaEmbedder's `kind`
 * (document for the corpus, query for the queries) — scoring gemma with one
 * symmetric prompt understates it and voids the comparison.
 *
 * The --sidecar leg speaks the D-004 API (POST {url}/embed { model, kind, texts })
 * so a candidate backend (Node-ONNX sidecar, Ollama, TEI) is measurable behind
 * the exact interface production would call.
 */
import fs from 'node:fs';
import path from 'node:path';

import { buildGemmaEmbedder, buildLocalEmbedder } from '@papercusp/memory';
import { buildOpenAiEmbedder, resolveOpenAiKey } from '../configure';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';

type EmbedFn = (text: string) => Promise<number[]>;
interface Leg {
  name: string;
  doc: EmbedFn;
  query: EmbedFn;
}

const K_VALUES = [1, 3, 5] as const;
const MRR_CUTOFF = 10;
const ANSWERABLE = new Set(['lexical-gap', 'exact-identifier', 'session-start-intent']);

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function l2norm(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** A leg that calls a running sidecar over the D-004 wire shape. */
function sidecarLeg(url: string, model: string): Leg {
  const call = (kind: 'document' | 'query'): EmbedFn => async (text: string) => {
    const res = await fetch(`${url.replace(/\/$/, '')}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, kind, texts: [text] }),
    });
    if (!res.ok) throw new Error(`sidecar_embed_${res.status}: ${await res.text().catch(() => '')}`);
    const j = (await res.json()) as { vectors: number[][] };
    return j.vectors[0];
  };
  return { name: `sidecar:${model}`, doc: call('document'), query: call('query') };
}

async function buildLegs(names: string[], sidecarUrl?: string): Promise<Array<Leg | { name: string; error: string }>> {
  const out: Array<Leg | { name: string; error: string }> = [];
  for (const name of names) {
    try {
      if (name === 'gemma') {
        out.push({
          name,
          doc: buildGemmaEmbedder({ kind: 'document' }),
          query: buildGemmaEmbedder({ kind: 'query' }),
        });
      } else if (name === 'local') {
        const fn = await buildLocalEmbedder();
        out.push({ name, doc: fn, query: fn });
      } else if (name === 'openai') {
        const key = await resolveOpenAiKey();
        if (!key) out.push({ name, error: 'no_key' });
        else {
          const fn = buildOpenAiEmbedder(key) as EmbedFn;
          out.push({ name, doc: fn, query: fn });
        }
      } else if (name.startsWith('sidecar')) {
        if (!sidecarUrl) out.push({ name, error: 'pass --sidecar <url>' });
        else out.push(sidecarLeg(sidecarUrl, name.includes(':') ? name.split(':')[1] : 'gemma'));
      } else {
        out.push({ name, error: `unknown leg '${name}'` });
      }
    } catch (e) {
      out.push({ name, error: `build_failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return out;
}

async function embedAll(fn: EmbedFn, texts: string[], label: string): Promise<{ vecs: number[][]; seconds: number }> {
  const vecs: number[][] = [];
  const t0 = Date.now();
  for (let i = 0; i < texts.length; i++) {
    vecs.push(l2norm(await fn(texts[i])));
    if ((i + 1) % 50 === 0) console.log(`  [${label}] ${i + 1}/${texts.length}`);
  }
  return { vecs, seconds: (Date.now() - t0) / 1000 };
}

interface ClassRow {
  n: number;
  recall_at_1: number;
  recall_at_3: number;
  recall_at_5: number;
  mrr_at_10: number;
}

function scoreLeg(
  corpusKeys: string[],
  docVecs: number[][],
  queries: Array<{ class: string; query: string; expected: string[] }>,
  queryVecs: number[][],
): { byClass: Record<string, ClassRow>; rejection: { answerableTop1Mean: number; hardNegTop1Mean: number; margin: number } } {
  const agg = new Map<string, { n: number; r: Record<number, number>; rrSum: number }>();
  const bump = (bucket: string, firstRel: number) => {
    let a = agg.get(bucket);
    if (!a) agg.set(bucket, (a = { n: 0, r: { 1: 0, 3: 0, 5: 0 }, rrSum: 0 }));
    a.n++;
    a.rrSum += firstRel <= MRR_CUTOFF ? 1 / firstRel : 0;
    for (const k of K_VALUES) if (firstRel <= k) a.r[k]++;
  };
  let ansTop1 = 0;
  let ansN = 0;
  let hnTop1 = 0;
  let hnN = 0;

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    const sims = docVecs.map((dv, di) => ({ di, s: dot(queryVecs[qi], dv) })).sort((a, b) => b.s - a.s);
    if (!ANSWERABLE.has(q.class)) {
      hnTop1 += sims[0]?.s ?? 0;
      hnN++;
      continue;
    }
    ansTop1 += sims[0]?.s ?? 0;
    ansN++;
    const exp = new Set(q.expected);
    let firstRel = Infinity;
    for (let r = 0; r < sims.length; r++) {
      if (exp.has(corpusKeys[sims[r].di])) {
        firstRel = r + 1;
        break;
      }
    }
    bump(q.class, firstRel);
    bump('ALL_ANSWERABLE', firstRel);
  }

  const byClass: Record<string, ClassRow> = {};
  for (const [c, a] of agg) {
    byClass[c] = {
      n: a.n,
      recall_at_1: +(a.r[1] / a.n).toFixed(4),
      recall_at_3: +(a.r[3] / a.n).toFixed(4),
      recall_at_5: +(a.r[5] / a.n).toFixed(4),
      mrr_at_10: +(a.rrSum / a.n).toFixed(4),
    };
  }
  const answerableTop1Mean = +(ansTop1 / Math.max(ansN, 1)).toFixed(4);
  const hardNegTop1Mean = +(hnTop1 / Math.max(hnN, 1)).toFixed(4);
  return {
    byClass,
    rejection: { answerableTop1Mean, hardNegTop1Mean, margin: +(answerableTop1Mean - hardNegTop1Mean).toFixed(4) },
  };
}

async function main(): Promise<void> {
  const legNames = argValue('--legs')?.split(',') ?? ['gemma', 'local'];
  const sidecarUrl = argValue('--sidecar');
  const outPath =
    argValue('--out') ??
    path.join(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..'),
      '.papercusp',
      'bench-reports',
      `embedder-eval-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
    );

  const corpus = loadCorpusFixture();
  const gold = loadGoldSetFixture();
  const corpusKeys = corpus.entries.map((e) => e.key);
  const corpusTexts = corpus.entries.map((e) => e.text);
  const queryTexts = gold.queries.map((q) => q.query);
  console.log(`corpus=${corpusKeys.length} queries=${gold.queries.length} legs=${legNames.join(',')}`);

  const results: Record<string, unknown> = {};
  for (const leg of await buildLegs(legNames, sidecarUrl)) {
    if ('error' in leg) {
      console.log(`\n== ${leg.name}: BLOCKED (${leg.error})`);
      results[leg.name] = { blocked: leg.error };
      continue;
    }
    console.log(`\n== ${leg.name}: embedding ==`);
    try {
      const doc = await embedAll(leg.doc, corpusTexts, `${leg.name}/doc`);
      const query = await embedAll(leg.query, queryTexts, `${leg.name}/query`);
      const scored = scoreLeg(corpusKeys, doc.vecs, gold.queries, query.vecs);
      results[leg.name] = {
        dims: doc.vecs[0]?.length ?? 0,
        docSeconds: +doc.seconds.toFixed(1),
        querySeconds: +query.seconds.toFixed(1),
        ...scored,
      };
      const a = scored.byClass.ALL_ANSWERABLE;
      console.log(
        `   ${leg.name}: R@1=${a.recall_at_1} R@3=${a.recall_at_3} R@5=${a.recall_at_5} MRR=${a.mrr_at_10} ` +
          `rejection-margin=${scored.rejection.margin}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`   ${leg.name} FAILED mid-embed: ${msg.slice(0, 200)}`);
      results[leg.name] = { blocked: `embed_failed: ${msg.slice(0, 200)}` };
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), corpusVersion: corpus.version, goldVersion: gold.version, results },
      null,
      2,
    ),
  );
  console.log('\nwrote', outPath);
  process.exit(0);
}

void main().catch((e) => {
  console.error('embedder-eval failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
