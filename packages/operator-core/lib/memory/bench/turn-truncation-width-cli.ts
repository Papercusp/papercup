/**
 * P-028(b) — does `left(text, 2000)` actually cost RECALL, and what should the cut be?
 *
 *   ./node_modules/.bin/tsx packages/operator-core/lib/memory/bench/turn-truncation-width-cli.ts
 *   [--sample 60] [--widths 2000,4000,6000,8000] [--model gemma]
 *
 * ─── THE CLAIM UNDER TEST ─────────────────────────────────────────────────
 * `embed-backfill.ts`'s session_turns bodySql is
 *     CASE WHEN length(text) >= 80 THEN left(text, 2000) ELSE '' END
 * so any turn longer than 2000 chars is embedded on its OPENING ONLY. Measured
 * live 2026-08-03: 33,171 turns (8.14%) exceed 2000 chars, averaging 4,730
 * chars, and 90,569,619 characters sit past the cut. The plan (P-028) asserts
 * that tail is "semantically invisible" and proposes CHUNKING.
 *
 * Two things must be measured before believing either half of that:
 *   1. Is the tail actually unretrievable today? (the defect)
 *   2. Does simply WIDENING the cut fix it — and where does the gain stop?
 *      (the remedy — which is the half that gets skipped, and the half that
 *      burned this plan on P-031, where the obvious remedy turned out to be
 *      byte-identical to the thing it was replacing.)
 *
 * ─── WHY WIDENING IS EVEN A CANDIDATE ─────────────────────────────────────
 * `SIDECAR_MAX_TEXT_CHARS` is 32_000 and `max(length(text))` over the live
 * session_turns table is exactly 8_000 (turns are capped upstream). So EVERY
 * turn already fits the transport with 4x headroom — the 2000-char cut is
 * matched to no transport limit at all. The real ceiling is the MODEL:
 * embeddinggemma-300m has a 2048-token window, and nothing in gemma-embedder.ts
 * passes a max_length, so Transformers.js truncates there silently. 8000 chars
 * of THIS corpus (mixed prose, code, JSON, logs) may or may not fit 2048 tokens
 * — which is exactly why this sweeps widths instead of assuming 4 chars/token.
 *
 * ─── WHY THIS IS A RANKING TEST, NOT A COSINE TEST ────────────────────────
 * D-010 of this plan: cosine under gemma carries a large positive offset —
 * random UNRELATED pairs mean .6119 — so an absolute cosine is uninterpretable
 * and a "similarity went up" result would be meaningless. The only sound
 * measure is RELATIVE: does the correct turn OUTRANK distractors. So each probe
 * is scored by the rank of its true parent turn among the whole sample, and the
 * arms are compared on MRR.
 *
 * ─── FAITHFULNESS ─────────────────────────────────────────────────────────
 * Embedding goes through the SAME `sidecarEmbedBatch` + `resolveProcessSidecarUrl`
 * path `embed-backfill.ts` uses, with the SAME asymmetric kinds ('document' for
 * the turn, 'query' for the probe). Getting that pair wrong would measure a
 * different space than production writes — WI-3616's whole failure mode.
 */
import { sidecarEmbedBatch } from '@papercusp/memory';
import pg from 'pg';

import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { EMBED_SIDECAR_CAP_EMBED } from '../embed-sidecar-server';
import { resolveProcessSidecarUrl } from '../embed-sidecar-wiring';

const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

const MODEL = argOf('--model') ?? 'gemma';
const SAMPLE = Number(argOf('--sample') ?? 60);
const WIDTHS = (argOf('--widths') ?? '2000,3000,4000,6000,8000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/** Where the probe is cut from — well past the 2000 cut, so it is invisible to the status quo. */
const PROBE_START = 3000;
const PROBE_LEN = 240;

interface Turn {
  key: string;
  text: string;
}

/**
 * Embed in small batches. A single 60-text call of ~5k-char documents aborts on
 * the client timeout — production batches at BATCH_SIZE for the same reason, so
 * a one-shot call here would be both slower and unlike the path being measured.
 */
async function embedChunked(
  url: string,
  kind: 'document' | 'query',
  texts: string[],
  size = 4,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    const res = await sidecarEmbedBatch(url, {
      model: MODEL,
      kind,
      texts: texts.slice(i, i + size),
      // The 15s default is sized for short texts on an idle box. These are
      // multi-kilobyte documents on a host running at ~100 load, and the
      // default aborts mid-sweep — which reads as a sidecar fault rather than
      // a client budget, so it is raised deliberately here.
      timeoutMs: 180_000,
    });
    out.push(...res.vectors);
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/**
 * A probe is only a fair test if it is DISTINCTIVE prose. A 240-char window of
 * pure punctuation/whitespace (a table rule, a base64 blob) would be
 * unretrievable at EVERY width and would depress all arms equally — noise, not
 * signal. Require some alphabetic density.
 */
function probeIsUsable(p: string): boolean {
  const letters = (p.match(/[A-Za-z]/g) ?? []).length;
  return letters / p.length > 0.5 && p.trim().split(/\s+/).length >= 15;
}

async function main(): Promise<void> {
  // `resolveProcessSidecarUrl` reads the OPERATOR process's capability registry,
  // which a standalone CLI has no part of — it returns null here even while the
  // sidecar is up and answering. Fall back to the same env var / default port the
  // other bench CLIs use rather than reporting a live sidecar as absent.
  const url =
    argOf('--sidecar') ??
    process.env.PAPERCUSP_EMBED_SIDECAR_URL ??
    (await resolveProcessSidecarUrl(undefined, [EMBED_SIDECAR_CAP_EMBED])) ??
    'http://127.0.0.1:3384';

  const client = new pg.Client({ connectionString: await getHarnessAdminUrl() });
  await client.connect();

  // Turns long enough to HAVE a tail past PROBE_START + PROBE_LEN. Deterministic
  // order so a re-run measures the same sample (this is an instrument, not a survey).
  const { rows } = await client.query<{ key: string; text: string }>(
    `SELECT (workspace_id || '|' || source_kind || '|' || session_id || '|' || turn_idx) AS key,
            text
       FROM harness_shared.session_turns
      WHERE length(text) >= $1
      ORDER BY ingested_at DESC
      LIMIT $2`,
    [PROBE_START + PROBE_LEN, SAMPLE * 3],
  );
  await client.end();

  const turns: Turn[] = [];
  for (const r of rows) {
    if (turns.length >= SAMPLE) break;
    if (probeIsUsable(r.text.slice(PROBE_START, PROBE_START + PROBE_LEN))) turns.push(r);
  }
  if (turns.length < 10) throw new Error(`only ${turns.length} usable turns — sample too small`);

  const probes = turns.map((t) => t.text.slice(PROBE_START, PROBE_START + PROBE_LEN));

  console.log(
    `[turn-truncation] model=${MODEL} turns=${turns.length} ` +
      `probe=[${PROBE_START}..${PROBE_START + PROBE_LEN}) widths=${WIDTHS.join(',')}`,
  );
  console.log(
    `[turn-truncation] mean turn length ${Math.round(
      turns.reduce((a, t) => a + t.text.length, 0) / turns.length,
    )} chars`,
  );

  // 'query' side — asymmetric model, must match production's query kind.
  const qvecs = await embedChunked(url, 'query', probes);

  console.log('\nwidth   MRR    recall@1  recall@5  meanRank  identical-to-2000');
  console.log('─────────────────────────────────────────────────────────────────');

  const baseline: { width: number; vecs: number[][] } = { width: 0, vecs: [] };
  for (const w of WIDTHS) {
    const docs = turns.map((t) => t.text.slice(0, w));
    const dvecs = await embedChunked(url, 'document', docs);
    if (baseline.vecs.length === 0) {
      baseline.width = w;
      baseline.vecs = dvecs;
    }

    let rr = 0;
    let r1 = 0;
    let r5 = 0;
    let rankSum = 0;
    for (let i = 0; i < probes.length; i++) {
      const scored = dvecs
        .map((dv, j) => ({ j, s: cosine(qvecs[i], dv) }))
        .sort((a, b) => b.s - a.s);
      const rank = scored.findIndex((x) => x.j === i) + 1;
      rr += 1 / rank;
      rankSum += rank;
      if (rank === 1) r1++;
      if (rank <= 5) r5++;
    }
    const n = probes.length;

    // Does widening change the VECTOR at all? If the model already truncated
    // internally, a wider cut is a no-op and this is how that shows up — a
    // flat MRR alone could not distinguish "no gain" from "no change applied".
    const identical = dvecs.filter((v, j) => cosine(v, baseline.vecs[j]) > 0.9999).length;

    console.log(
      `${String(w).padEnd(7)} ${(rr / n).toFixed(4)} ${((r1 / n) * 100).toFixed(1).padStart(7)}% ` +
        `${((r5 / n) * 100).toFixed(1).padStart(8)}% ${(rankSum / n).toFixed(2).padStart(9)} ` +
        `${String(identical).padStart(12)}/${n}`,
    );
  }

  console.log(
    '\nReading it: the probe text lives at chars ' +
      `${PROBE_START}-${PROBE_START + PROBE_LEN}, so at width 2000 it is ABSENT from the ` +
      'embedded document. A large MRR gain from 2000 -> wider is the recall the current cut ' +
      'is throwing away. Where MRR stops climbing is the effective model window, and the ' +
      'identical-to-2000 column proves whether a wider cut changed the vector at all.',
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
