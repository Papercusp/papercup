/**
 * wi-6512-known-item-replay-cli.ts — THE P-018 ACCEPTANCE MEASUREMENT.
 *
 * Replays the seven reconstructed WI-6512 investigation batches against the LIVE
 * mid-turn-context endpoint and counts how many hand back the already-recorded
 * answer. This is the RELEVANCE instrument: the corpus-leg acceptance CLI
 * measures how MANY lines get admitted, and says nothing about whether they are
 * the RIGHT ones. A change that admits more noise scores identically there and
 * scores zero here.
 *
 *   npx tsx packages/operator-core/lib/memory/bench/wi-6512-known-item-replay-cli.ts
 *
 * ⚠ TARGET :3170 (staging), not :3070. :3070 runs from the release checkout, so
 * it answers about code that shipped, not code you just wrote. :3170 runs from
 * this integration tree — but it does NOT hot-reload, so after a server-side edit
 * you must `dev:restart { target: 'staging', confirm: true }` or you will
 * measure the previous build and believe you measured yours.
 *
 * ═══ THE TWO MODES ARE DIFFERENT QUESTIONS — DO NOT AVERAGE THEM ════════════
 *
 * This is the methodological trap in the measurement, and it is invisible if you
 * only ever run one mode:
 *
 *   SEQUENTIAL — one fresh session, seven batches in order, as a real agent
 *   experiences them. D-006's session-epoch dedup stamps a record the first time
 *   it surfaces and never re-pays it, so the count of batches carrying WI-6512 is
 *   CAPPED AT 1 BY DESIGN. Here "1 of 7" is a PERFECT score and 2 would be a
 *   dedup regression. Reading it as "1 hit, 6 misses" reports the dedup working
 *   as though it were retrieval failing.
 *
 *   INDEPENDENT — a fresh session per batch, so every batch's derived query is
 *   judged on its own with an empty ledger. Ceiling 7. This is the only mode in
 *   which "batches 2-7 cannot move at any budget" (the acceptance test header's
 *   claim about WI-7237/P-018) is a statement that can be true or false.
 *
 * Both are printed, always, labelled with their own ceiling. The headline
 * acceptance number is the INDEPENDENT one.
 *
 * ⚠ A green run of `mid-turn-context.p018-acceptance.test.ts` is NOT this
 * measurement and never was — that file mocks the store, and its own header says
 * so at length. It shares this replay's seven batches by import (see
 * `wi-6512-replay.ts`) precisely so the two cannot drift apart.
 */
import { ANSWER_RECORDS, KNOWN_ITEM, REPLAY, carriesAnswer, type ReplayBatch } from './wi-6512-replay';
import { deriveBatchQuery, splitLegQueries } from '../../endpoint-route/routes/agent-mcp/mid-turn-context';

interface Args {
  base: string;
  passes: number;
  harness: string;
  workspace: string;
  verbose: boolean;
  /** 'none' runs the in-process probes only — no live endpoint, no staging restart needed. */
  mode: 'both' | 'independent' | 'sequential' | 'none';
  explainSelection: boolean;
  arms: boolean;
  oracle: boolean;
  oracleMaxTerms: number;
}

/**
 * THE ORACLE — which INDIVIDUAL candidate terms retrieve an answer-bearing
 * record at all, and would any selector have been able to pick them?
 *
 * This is a CEILING measurement, run BEFORE designing a replacement selector
 * (WI-9273), because that ordering is exactly what P-018 got wrong: a mechanism
 * was built on a plausible story about which terms are good, and the story was
 * false. Here nothing is designed — every candidate term is simply tried, and
 * the corpus says which ones work.
 *
 * It answers three questions no selector-vs-selector comparison can:
 *   1. Is 2/7 near the ceiling, or is 7/7 reachable? If a batch has NO winning
 *      term, no choice of two terms can save it and the fix is not selection at
 *      all (it is reach, or the 2-term cap, or the corpus).
 *   2. What do the winners have in common? If nothing learnable — not rarity,
 *      not length, not position — then ranked single-term selection is a dead
 *      end and the honest answer is to stop trying to pick.
 *   3. Did either shipped selector actually have the winner in reach? A selector
 *      that never had the right term as a candidate is failing earlier than its
 *      ranking rule.
 */
async function runOracle(args: Args): Promise<void> {
  const [{ corpusQueryText, corpusTerms }, { corpusTermDfLookup }, { recallCorpusContext }, { getOrgPg }] =
    await Promise.all([
      import('../corpus-recall'),
      import('../corpus-term-df'),
      import('../corpus-recall-io'),
      import('@papercusp/db-org'),
    ]);
  const { sql } = getOrgPg();
  const df = await corpusTermDfLookup(sql, 'papercusp-workspace');

  console.log('\n## ORACLE — which SINGLE candidate terms retrieve an answer-bearing record?');
  console.log(`   (ceiling for WI-9273: ALL 2-term pairs over the first ${args.oracleMaxTerms} candidates)\n`);

  let batchesWithAnyWinner = 0;
  const winnerProfile: Array<{ term: string; df: number; len: number; pos: number; batch: number }> = [];

  for (const batch of REPLAY) {
    const raw = deriveBatchQuery(batch.calls);
    const terms = corpusTerms(raw).slice(0, args.oracleMaxTerms);
    const picks = {
      length: corpusQueryText(raw).split(' '),
      banded: df ? corpusQueryText(raw, undefined, { df }).split(' ') : [],
    };

    // PAIRS, not single terms. ⚠ This is a CORRECTION of this probe's first
    // version, and the bug is worth stating because it is counter-intuitive:
    // single-term retrieval is NOT a lower bound for two-term retrieval. The leg
    // issues an AND (then P-017's graded cascade), so adding a term makes the
    // query MORE selective — two terms can surface a record that NEITHER term
    // surfaces alone. Measured here: turn 69 retrieves WI-6512 on
    // "sessions explain", while `sessions` alone and `explain` alone both miss.
    // A single-term sweep therefore reports batches as "unreachable" that are
    // perfectly reachable, which is a false ceiling in the expensive direction —
    // it argues for abandoning selection when selection is exactly what works.
    const results: Array<{ term: string; win: boolean }> = [];
    const queue: string[] = [];
    for (let i = 0; i < terms.length; i++) {
      for (let j = i + 1; j < terms.length; j++) queue.push(`${terms[i]} ${terms[j]}`);
    }
    const worker = async (): Promise<void> => {
      for (;;) {
        const term = queue.shift();
        if (term === undefined) return;
        const res = await recallCorpusContext({
          queryText: term,
          workspaceId: 'papercusp-workspace',
          harnessSlugs: ['papercusp'],
        });
        const rendered = res.lines.map((l) => l.line).join('\n');
        results.push({ term, win: carriesAnswer(rendered) !== undefined });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    const winners = results.filter((r) => r.win).map((r) => r.term);
    if (winners.length > 0) batchesWithAnyWinner++;
    for (const w of winners) {
      const [a, b] = w.split(' ') as [string, string];
      winnerProfile.push({
        term: w,
        df: df ? Math.min(df(a), df(b)) : -1,
        len: Math.max(a.length, b.length),
        pos: Math.max(terms.indexOf(a), terms.indexOf(b)),
        batch: batch.turn,
      });
    }

    const same = (pair: string, picked: string[]): boolean => {
      const p = pair.split(' ');
      return picked.length === 2 && p.every((t) => picked.includes(t));
    };
    console.log(`   turn ${batch.turn}  (${results.length} pairs probed over ${terms.length} candidates)`);
    if (winners.length === 0) {
      console.log(`     winners: (NONE — no 2-term pair in the candidate pool retrieves the answer)`);
    } else {
      const shown = winners
        .slice(0, 8)
        .map((w) => `"${w}"${same(w, picks.length) ? '[L]' : ''}${same(w, picks.banded) ? '[B]' : ''}`);
      console.log(`     winners (${winners.length}): ${shown.join('  ')}${winners.length > 8 ? '  …' : ''}`);
      console.log(
        `     did a shipped selector pick one?  LENGTH ${winners.some((w) => same(w, picks.length)) ? 'YES' : 'no'}` +
          `   BANDED ${winners.some((w) => same(w, picks.banded)) ? 'YES' : 'no'}`,
      );
    }
  }

  console.log(`\n   Batches with >=1 winning single term: ${batchesWithAnyWinner}/${REPLAY.length}`);
  console.log(`   [L] = the LENGTH proxy picked it   [B] = BANDED picked it`);
  if (winnerProfile.length > 0) {
    const dfs = winnerProfile.map((w) => w.df).filter((d) => d >= 0);
    const lens = winnerProfile.map((w) => w.len);
    console.log(`\n   Winner profile (what a selector would have to prefer):`);
    console.log(`     df   min ${Math.min(...dfs)}  max ${Math.max(...dfs)}  (banded prefers the MINIMUM)`);
    console.log(`     len  min ${Math.min(...lens)}  max ${Math.max(...lens)}  (length prefers the MAXIMUM)`);
    for (const w of winnerProfile) {
      console.log(`     turn ${w.batch}: "${w.term}" df=${w.df} len=${w.len} candidatePos=${w.pos}`);
    }
  }
  console.log(
    `\n   ⚠ A batch with NO winning single term cannot be fixed by choosing different terms —` +
      ` that is a reach/cap problem, not a selection problem.`,
  );
}

/**
 * The paired arm comparison: for each batch, run the REAL corpus leg twice —
 * once with the query the LENGTH proxy would have chosen, once with the query
 * P-018's BANDED selection actually chooses — and ask which one retrieves a
 * record that answers the question.
 *
 * WHY THIS IS THE PRODUCTION PATH AND NOT AN APPROXIMATION: `recallCorpusContext`
 * derives its own query via `corpusQueryText(rawText)`. Feed it a rawText that is
 * ALREADY the two selected terms and both selections re-select the same two (two
 * candidates, k=2, neither an id) — so the query reaching the engine is exactly
 * that arm's, whichever selection happens to be wired on. Same engine, same
 * sources, same floors, same collapse. No fork of production behaviour, and no
 * flag to flip.
 *
 * Both arms run back-to-back against the SAME live corpus, which is what closes
 * the drift confounder: a difference between them cannot be "the corpus changed
 * since the baseline".
 */
async function compareArms(): Promise<void> {
  const [{ corpusQueryText }, { corpusTermDfLookup }, { recallCorpusContext }, { getOrgPg }] =
    await Promise.all([
      import('../corpus-recall'),
      import('../corpus-term-df'),
      import('../corpus-recall-io'),
      import('@papercusp/db-org'),
    ]);
  const { sql } = getOrgPg();
  const df = await corpusTermDfLookup(sql, 'papercusp-workspace');
  console.log('\n## ARM COMPARISON — does the arm\'s query retrieve an ANSWER-BEARING record?');
  if (!df) {
    console.log('   ⚠ no DF snapshot; both arms would be identical. Nothing to compare.');
    return;
  }

  const probe = async (query: string): Promise<{ hit: string; lines: number; top: string }> => {
    const res = await recallCorpusContext({
      queryText: query,
      workspaceId: 'papercusp-workspace',
      harnessSlugs: ['papercusp'],
    });
    const rendered = res.lines.map((l) => l.line).join('\n');
    const found = carriesAnswer(rendered);
    return {
      hit: found ? found.marker.slice(0, 8) : '',
      lines: res.lines.length,
      top: (res.lines[0]?.line ?? '').slice(0, 90),
    };
  };

  let lengthHits = 0;
  let bandedHits = 0;
  for (const batch of REPLAY) {
    const raw = deriveBatchQuery(batch.calls);
    const qLength = corpusQueryText(raw);
    const qBanded = corpusQueryText(raw, undefined, { df });
    const [a, b] = await Promise.all([probe(qLength), probe(qBanded)]);
    if (a.hit) lengthHits++;
    if (b.hit) bandedHits++;
    console.log(`\n   turn ${batch.turn}`);
    console.log(`     LENGTH "${qLength}" -> ${a.lines} lines  ${a.hit ? `✓ ANSWER via ${a.hit}` : '·'}`);
    console.log(`       top: ${a.top}`);
    console.log(`     BANDED "${qBanded}" -> ${b.lines} lines  ${b.hit ? `✓ ANSWER via ${b.hit}` : '·'}`);
    console.log(`       top: ${b.top}`);
  }
  console.log(
    `\n   ANSWER-BEARING batches — LENGTH ${lengthHits}/${REPLAY.length}   BANDED ${bandedHits}/${REPLAY.length}`,
  );
  if (bandedHits < lengthHits) {
    console.log(`   → P-018 BANDED selection RETRIEVES THE ANSWER LESS OFTEN than the proxy it replaced.`);
  }
}

/**
 * P-018's term selection, side by side with the length proxy it replaced, on
 * THIS replay's own queries.
 *
 * Why it belongs in the acceptance instrument rather than a scratch script: a
 * number that moves between two runs of this CLI has two very different causes —
 * the corpus leg ASKED something different, or it asked the same thing and
 * retrieval answered differently. Those call for opposite next steps, and
 * nothing else here can tell them apart. Reads the live DF snapshot, so it
 * reports what the endpoint would actually do right now.
 */
async function explainSelection(): Promise<void> {
  const [{ getOrgPg }, { corpusQueryText, corpusTerms }, { corpusTermDfLookup }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../corpus-recall'),
    import('../corpus-term-df'),
  ]);
  const { sql } = getOrgPg();
  const df = await corpusTermDfLookup(sql, 'papercusp-workspace');
  console.log('\n## Corpus-leg term selection — LENGTH (pre-P-018) vs BANDED (P-018)');
  if (!df) {
    console.log('   ⚠ NO DF SNAPSHOT — banded selection is INACTIVE and the leg is falling back');
    console.log('     to length. Any "P-018 is live" claim is false until this populates.');
    return;
  }
  for (const batch of REPLAY) {
    const raw = deriveBatchQuery(batch.calls);
    const terms = corpusTerms(raw);
    const byLength = corpusQueryText(raw);
    const banded = corpusQueryText(raw, undefined, { df });
    console.log(`\n   turn ${batch.turn}`);
    console.log(`     candidates: ${terms.slice(0, 12).map((t) => `${t}(${df(t)})`).join(' ')}`);
    console.log(`     LENGTH -> "${byLength}"`);
    console.log(`     BANDED -> "${banded}"   ${byLength === banded ? '(same)' : '*** CHANGED ***'}`);
  }
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const modeRaw = get('--mode') ?? 'both';
  if (modeRaw !== 'both' && modeRaw !== 'independent' && modeRaw !== 'sequential' && modeRaw !== 'none') {
    throw new Error(`--mode must be both|independent|sequential|none, got ${modeRaw}`);
  }
  return {
    base: (get('--base') ?? 'http://127.0.0.1:3170').replace(/\/$/, ''),
    passes: Number(get('--passes') ?? 3),
    harness: get('--harness') ?? 'papercusp',
    workspace: get('--workspace') ?? 'papercusp-workspace',
    verbose: argv.includes('--verbose'),
    mode: modeRaw,
    explainSelection: argv.includes('--explain-selection'),
    arms: argv.includes('--arms'),
    oracle: argv.includes('--oracle'),
    oracleMaxTerms: Number(get('--oracle-max-terms') ?? 10),
  };
}

/** One POST to the live endpoint. Returns the injected block ('' = nothing pushed). */
async function post(args: Args, owner: string, batch: ReplayBatch): Promise<string> {
  const res = await fetch(`${args.base}/api/agent-mcp/mid-turn-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner,
      toolCalls: batch.calls,
      harness: args.harness,
      workspace: args.workspace,
      cwd: process.cwd(),
    }),
  });
  if (!res.ok) throw new Error(`endpoint ${res.status} ${res.statusText} — is :3170 up?`);
  const payload = (await res.json()) as { ok?: boolean; text?: string };
  return typeof payload.text === 'string' ? payload.text : '';
}

interface BatchResult {
  turn: number;
  /** STRICT: the literal work-item id — comparable to the 1-of-7 baseline. */
  strict: boolean;
  /** ANSWER: any enumerated answer-bearing record — matches the acceptance claim. */
  answer: boolean;
  /** Which answer-bearing record arrived, when one did. */
  via: string;
  chars: number;
  /** Pointer lines that came back INSTEAD, when no answer record did. */
  instead: string[];
}

function score(turn: number, block: string): BatchResult {
  const found = carriesAnswer(block);
  return {
    turn,
    strict: block.includes(KNOWN_ITEM),
    answer: found !== undefined,
    via: found ? found.marker.slice(0, 8) : '',
    chars: block.length,
    instead: found ? [] : pointerLines(block).slice(0, 3),
  };
}

const nonce = (): string => Math.random().toString(36).slice(2, 8);

/** Extract the bullet lines a block carries, for the "what came back instead" column. */
function pointerLines(block: string): string[] {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') || l.startsWith('• '))
    .map((l) => l.replace(/^[-•]\s*/, ''));
}

async function runIndependent(args: Args, pass: number): Promise<BatchResult[]> {
  const out: BatchResult[] = [];
  for (const batch of REPLAY) {
    // Fresh owner PER BATCH — an empty epoch ledger, so nothing this replay
    // already surfaced can suppress this batch's own retrieval.
    out.push(score(batch.turn, await post(args, `p018-live-i${pass}-t${batch.turn}-${nonce()}`, batch)));
  }
  return out;
}

async function runSequential(args: Args, pass: number): Promise<BatchResult[]> {
  const owner = `p018-live-s${pass}-${nonce()}`;
  const out: BatchResult[] = [];
  for (const batch of REPLAY) out.push(score(batch.turn, await post(args, owner, batch)));
  return out;
}

interface ModeSummary {
  strict: number[];
  answer: number[];
}

function summarise(label: string, ceiling: number, passes: BatchResult[][], verbose: boolean): ModeSummary {
  console.log(`\n## ${label}`);
  console.log(`   ceiling ${ceiling} of ${REPLAY.length}`);
  console.log(`   S = STRICT (literal ${KNOWN_ITEM}) · A = ANSWER (any answer-bearing record)\n`);
  const cols = passes.map((_, i) => `p${i + 1}`).join('   ');
  console.log(`   turn  ${cols}   chars(p1)  via`);
  for (let b = 0; b < REPLAY.length; b++) {
    const cells = passes
      .map((p) => `${p[b]!.strict ? 'S' : '·'}${p[b]!.answer ? 'A' : '·'}`.padEnd(5))
      .join('');
    console.log(
      `   ${String(REPLAY[b]!.turn).padEnd(6)}${cells}${String(passes[0]![b]!.chars).padEnd(11)}${passes[0]![b]!.via}`,
    );
  }
  const strict = passes.map((p) => p.filter((r) => r.strict).length);
  const answer = passes.map((p) => p.filter((r) => r.answer).length);
  console.log(`\n   STRICT per pass: ${strict.map((h) => `${h}/${REPLAY.length}`).join('  ')}`);
  console.log(`   ANSWER per pass: ${answer.map((h) => `${h}/${REPLAY.length}`).join('  ')}`);

  if (verbose) {
    console.log('\n   what came back INSTEAD (pass 1, batches carrying NO answer record):');
    for (const r of passes[0]!) {
      if (r.answer || r.instead.length === 0) continue;
      console.log(`     turn ${r.turn}:`);
      for (const line of r.instead) console.log(`       ${line.slice(0, 150)}`);
    }
  }
  return { strict, answer };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`# WI-6512 known-item replay — P-018 ACCEPTANCE (relevance)`);
  console.log(`  endpoint ${args.base}/api/agent-mcp/mid-turn-context`);
  console.log(`  harness=${args.harness} workspace=${args.workspace} passes=${args.passes}`);
  console.log(`  looking for: ${KNOWN_ITEM} in the injected block`);

  // The derived queries are part of the record — a measurement that moved
  // because the QUERY changed is a different finding from one that moved
  // because retrieval improved, and only this makes them distinguishable.
  console.log('\n## Derived queries (what each batch actually asks)');
  for (const batch of REPLAY) {
    const derived = deriveBatchQuery(batch.calls);
    const { cosine, lexical } = splitLegQueries(derived);
    console.log(`   turn ${batch.turn}`);
    console.log(`     lexical: ${lexical.slice(0, 160)}`);
    if (cosine !== lexical) console.log(`     cosine : ${cosine.slice(0, 160)}`);
  }

  if (args.explainSelection) await explainSelection();
  if (args.arms) await compareArms();
  if (args.oracle) await runOracle(args);

  let independent: ModeSummary | undefined;
  let sequential: ModeSummary | undefined;

  if (args.mode === 'both' || args.mode === 'independent') {
    const passes: BatchResult[][] = [];
    for (let p = 1; p <= args.passes; p++) passes.push(await runIndependent(args, p));
    independent = summarise(
      'INDEPENDENT — fresh session per batch (THE ACCEPTANCE NUMBER)',
      REPLAY.length,
      passes,
      args.verbose,
    );
  }

  if (args.mode === 'both' || args.mode === 'sequential') {
    const passes: BatchResult[][] = [];
    for (let p = 1; p <= args.passes; p++) passes.push(await runSequential(args, p));
    sequential = summarise(
      'SEQUENTIAL — one session, seven batches in order (dedup-capped)',
      1,
      passes,
      args.verbose,
    );
  }

  const range = (xs: number[]): string => {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return lo === hi ? `${lo}` : `${lo}-${hi}`;
  };

  console.log('\n## Verdict');
  if (independent) {
    const s = independent.strict;
    const a = independent.answer;
    console.log(`   STRICT (literal ${KNOWN_ITEM}): ${range(s)} of ${REPLAY.length}.`);
    console.log(`     Baseline 2026-08-03, same criterion, was 1 of 7 (batch ONE only).`);
    const hi = Math.max(...s);
    if (hi > 1) console.log(`     → MOVED UP. Batches beyond the first now reach the work-item itself.`);
    else if (hi === 1) console.log(`     → UNCHANGED at the baseline.`);
    else console.log(`     → REGRESSED. Even batch one no longer names the work-item.`);
    console.log(`   ANSWER (any of ${ANSWER_RECORDS.length} answer-bearing records): ${range(a)} of ${REPLAY.length}.`);
    console.log(`     ⚠ NOT comparable to the 1-of-7 baseline — that number was never scored this way.`);
    console.log(`     This is the criterion that matches the claim "saves the other twelve calls".`);
  }
  if (sequential) {
    const bad = sequential.answer.filter((h) => h > 1);
    console.log(
      `   DEDUP (sequential ANSWER): ${sequential.answer.map((h) => `${h}/7`).join(' ')} — ` +
        (bad.length === 0 ? 'capped at 1 as designed ✓' : '⚠ >1 means the epoch dedup re-paid a record'),
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
