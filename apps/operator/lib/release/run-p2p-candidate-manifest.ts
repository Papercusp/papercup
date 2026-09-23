/**
 * run-p2p-candidate-manifest.ts — CLI entry point for `buildP2pCandidateManifest()`
 * (p2p-public-release-endgame-2026-09-01 D-038, WI-10002524). Mirrors
 * run-autoloop-release-profile.ts.
 *
 *   npx tsx apps/operator/lib/release/run-p2p-candidate-manifest.ts \
 *     --provenance <candidate.json> [--journeys <journeys.json>] [--history <manifest.json>] --out <manifest.json>
 *
 * `candidate.json` is a `P2pCandidateProvenance` ({ version, channel, sourceSha,
 * artifacts:[{name,sha256}] }). `journeys.json` maps P-521 journey keys to
 * `P2pJourneyResult`s. `--history` appends the prior manifest's current interpretation
 * to history, so re-running after each journey keeps history append-only.
 * Writes the manifest JSON to --out and prints the readiness table to stdout.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  appendReadinessHistory,
  renderReadinessTable,
  serializeCurrentReadinessManifest,
  type CurrentReadinessManifest,
  type ReadinessHistoryEntry,
} from './current-readiness-manifest';
import {
  buildP2pCandidateManifest,
  type P2pCandidateProvenance,
  type P2pJourneyResult,
} from './p2p-candidate-manifest';

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function main(argv: readonly string[]): Promise<void> {
  const provenancePath = flag(argv, 'provenance');
  const outPath = flag(argv, 'out');
  if (!provenancePath || !outPath) {
    throw new Error('usage: --provenance <candidate.json> [--journeys <journeys.json>] [--history <manifest.json>] --out <manifest.json>');
  }
  const journeysPath = flag(argv, 'journeys');
  const historyPath = flag(argv, 'history');
  let history: readonly ReadinessHistoryEntry[] | undefined;
  if (historyPath) {
    const prior = readJson<CurrentReadinessManifest>(historyPath);
    history = appendReadinessHistory(prior).history;
  }
  const manifest = await buildP2pCandidateManifest({
    candidate: readJson<P2pCandidateProvenance>(provenancePath),
    journeys: journeysPath ? readJson<Record<string, P2pJourneyResult>>(journeysPath) : undefined,
    history,
  });
  writeFileSync(outPath, `${serializeCurrentReadinessManifest(manifest)}\n`);
  console.log(renderReadinessTable(manifest));
  console.log(`artifact ${manifest.artifact.id} sha256=${manifest.artifact.sha256} go=${manifest.current.go}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('[run-p2p-candidate-manifest] FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
}
