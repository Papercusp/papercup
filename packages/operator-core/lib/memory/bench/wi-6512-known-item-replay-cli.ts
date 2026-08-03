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
import { KNOWN_ITEM, REPLAY, type ReplayBatch } from './wi-6512-replay';
import { deriveBatchQuery, splitLegQueries } from '../../endpoint-route/routes/agent-mcp/mid-turn-context';

interface Args {
  base: string;
  passes: number;
  harness: string;
  workspace: string;
  verbose: boolean;
  mode: 'both' | 'independent' | 'sequential';
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const modeRaw = get('--mode') ?? 'both';
  if (modeRaw !== 'both' && modeRaw !== 'independent' && modeRaw !== 'sequential') {
    throw new Error(`--mode must be both|independent|sequential, got ${modeRaw}`);
  }
  return {
    base: (get('--base') ?? 'http://127.0.0.1:3170').replace(/\/$/, ''),
    passes: Number(get('--passes') ?? 3),
    harness: get('--harness') ?? 'papercusp',
    workspace: get('--workspace') ?? 'papercusp-workspace',
    verbose: argv.includes('--verbose'),
    mode: modeRaw,
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
  hit: boolean;
  chars: number;
  /** Pointer/heading lines that came back INSTEAD, when the known item did not. */
  instead: string[];
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
    const block = await post(args, `p018-live-i${pass}-t${batch.turn}-${nonce()}`, batch);
    const hit = block.includes(KNOWN_ITEM);
    out.push({
      turn: batch.turn,
      hit,
      chars: block.length,
      instead: hit ? [] : pointerLines(block).slice(0, 3),
    });
  }
  return out;
}

async function runSequential(args: Args, pass: number): Promise<BatchResult[]> {
  const owner = `p018-live-s${pass}-${nonce()}`;
  const out: BatchResult[] = [];
  for (const batch of REPLAY) {
    const block = await post(args, owner, batch);
    const hit = block.includes(KNOWN_ITEM);
    out.push({ turn: batch.turn, hit, chars: block.length, instead: hit ? [] : pointerLines(block).slice(0, 3) });
  }
  return out;
}

function summarise(label: string, ceiling: number, passes: BatchResult[][], verbose: boolean): number[] {
  console.log(`\n## ${label}`);
  console.log(`   ceiling ${ceiling} of ${REPLAY.length}\n`);
  const perPassHits: number[] = [];
  const header = ['turn', ...passes.map((_, i) => `p${i + 1}`), 'chars(p1)'];
  console.log(`   ${header[0]!.padEnd(6)}${header.slice(1, -1).map((h) => h.padEnd(5)).join('')}${header.at(-1)}`);
  for (let b = 0; b < REPLAY.length; b++) {
    const cells = passes.map((p) => (p[b]!.hit ? ' ✓   ' : ' ·   '));
    console.log(`   ${String(REPLAY[b]!.turn).padEnd(6)}${cells.join('')}${passes[0]![b]!.chars}`);
  }
  for (const p of passes) perPassHits.push(p.filter((r) => r.hit).length);
  console.log(`\n   hits per pass: ${perPassHits.map((h) => `${h}/${REPLAY.length}`).join('  ')}`);

  if (verbose) {
    console.log('\n   what came back INSTEAD (pass 1 misses):');
    for (const r of passes[0]!) {
      if (r.hit || r.instead.length === 0) continue;
      console.log(`     turn ${r.turn}:`);
      for (const line of r.instead) console.log(`       ${line.slice(0, 150)}`);
    }
  }
  return perPassHits;
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

  let independentHits: number[] = [];
  let sequentialHits: number[] = [];

  if (args.mode === 'both' || args.mode === 'independent') {
    const passes: BatchResult[][] = [];
    for (let p = 1; p <= args.passes; p++) passes.push(await runIndependent(args, p));
    independentHits = summarise(
      'INDEPENDENT — fresh session per batch (THE ACCEPTANCE NUMBER)',
      REPLAY.length,
      passes,
      args.verbose,
    );
  }

  if (args.mode === 'both' || args.mode === 'sequential') {
    const passes: BatchResult[][] = [];
    for (let p = 1; p <= args.passes; p++) passes.push(await runSequential(args, p));
    sequentialHits = summarise(
      'SEQUENTIAL — one session, seven batches in order (dedup-capped)',
      1,
      passes,
      args.verbose,
    );
  }

  console.log('\n## Verdict');
  if (independentHits.length > 0) {
    const lo = Math.min(...independentHits);
    const hi = Math.max(...independentHits);
    const range = lo === hi ? `${lo}` : `${lo}-${hi}`;
    console.log(`   ACCEPTANCE (independent): ${range} of ${REPLAY.length} batches retrieve ${KNOWN_ITEM}.`);
    console.log(`   Baseline before P-007+P-018 was 1 of 7 (batch ONE only).`);
    if (hi > 1) {
      console.log(`   → MOVED. Batches beyond the first now reach the known item.`);
    } else {
      console.log(`   → NOT MOVED. Only batch one reaches it; the extra admitted lines are not this record.`);
    }
  }
  if (sequentialHits.length > 0) {
    const bad = sequentialHits.filter((h) => h > 1);
    console.log(
      `   DEDUP (sequential): ${sequentialHits.map((h) => `${h}/7`).join(' ')} — ` +
        (bad.length === 0 ? 'capped at 1 as designed ✓' : '⚠ >1 means the epoch dedup re-paid a record'),
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
