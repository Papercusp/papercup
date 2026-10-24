/** Evidence of actual adapter execution, separate from quality/latency acceptance. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { reconcileBm25Attempts, type Bm25AttemptReceipt, type declareBm25Attempts } from '../../search/bench/bm25-hybrid-recall';

export function benchmarkRuntimeArguments(args: readonly string[]): string[] {
  const separator = args.indexOf('--');
  const selected = args.slice(separator + 1);
  const out = selected.indexOf('--out');
  if (separator < 0 || out < 0 || !selected[out + 1]?.endsWith('.json')
    || selected.filter(value => value === '--out').length !== 1
    || selected.some(value => ['--prepare-only','--replay-from','--replay-indices','--replay-reps'].includes(value)))
    throw new Error('runtime benchmark requires -- followed by an actual run and one new --out JSON path');
  return selected;
}

export function readBenchmarkRuntimeEvidence(args: readonly string[], exitCode: number) {
  const output = path.resolve(args[args.indexOf('--out') + 1]);
  const read = (file: string) => {
    const bytes = fs.readFileSync(file);
    return { pin: { path:file, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex') }, bytes };
  };
  const artifact = read(output), declaration = read(output+'.declaration.json');
  const attempts = read(output+'.attempts.jsonl'), ledger = read(output+'.ledger.json');
  const result = JSON.parse(artifact.bytes.toString());
  const declared: ReturnType<typeof declareBm25Attempts> = JSON.parse(declaration.bytes.toString());
  const receipts: Bm25AttemptReceipt[] = attempts.bytes.toString().trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const reconciled = reconcileBm25Attempts(declared,receipts);
  if (![0,1].includes(exitCode) || result.kind!=='bm25-hybrid-recall'
    || !['pass','fail'].includes(result.verdict) || !['pass','fail'].includes(result.latencyVerdict)
    || result.queryEmbeddingProfile?.mode!=='gemma' || result.queryEmbeddingProfile?.profileId!=='gemma-embeddinggemma-300m-768@v1'
    || !declared.attempts.length || receipts.length!==declared.attempts.length
    || reconciled.attempts.some(attempt=>!attempt.executed || attempt.outcome!=='success' || !attempt.observation)
    || !isDeepStrictEqual(reconciled,JSON.parse(ledger.bytes.toString()))
    || !isDeepStrictEqual(result.population?.declaration,declared)
    || !isDeepStrictEqual(result.population?.ledger,reconciled))
    throw new Error('runtime benchmark lacks a complete matching actual execution population');
  return { exitCode, artifact:artifact.pin, declaration:declaration.pin, attempts:attempts.pin, ledger:ledger.pin,
    executed:receipts.length, cells:reconciled.cells, verdict:result.verdict as string, latencyVerdict:result.latencyVerdict as string,
    searchAdapterExercised:true, baselineAccepted:false, latencyAcceptance:false,
    scope:'real runHybridSearch requests under intrusive runtime instrumentation; independent corpus, budgets and acceptance still required' };
}
