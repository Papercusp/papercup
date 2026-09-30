/**
 * Regenerate libs/generic/search/src/__fixtures__/embedding-space-parity-cases.json
 * from papercusp's pre-move embedding-space functions (see
 * embedding-space-parity-cases.ts). embedding-space-parity.test.ts fails until
 * the committed fixture equals what this writes.
 *
 *   npx tsx packages/operator-core/lib/search/embedding-space-parity-gen-cli.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEmbeddingSpaceParityFixture } from './embedding-space-parity-cases';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../libs/generic/search/src/__fixtures__/embedding-space-parity-cases.json', import.meta.url),
);

const body = `${JSON.stringify(buildEmbeddingSpaceParityFixture(REPO_ROOT), null, 2)}\n`;
if (process.argv.includes('--check')) {
  const same = readFileSync(FIXTURE_PATH, 'utf8') === body;
  console.log(same ? 'EMBEDDING_SPACE_FIXTURE current' : 'EMBEDDING_SPACE_FIXTURE stale');
  process.exit(same ? 0 : 1);
}
writeFileSync(FIXTURE_PATH, body);
const f = JSON.parse(body) as { census: unknown[]; columnPairs: unknown[]; predicate: unknown[]; sourceFilter: unknown[] };
console.log(`EMBEDDING_SPACE_FIXTURE written census=${f.census.length} pairs=${f.columnPairs.length} predicate=${f.predicate.length} sourceFilter=${f.sourceFilter.length}`);
