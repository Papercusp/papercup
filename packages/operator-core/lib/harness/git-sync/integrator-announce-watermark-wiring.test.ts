/**
 * WI-10003781 — wiring guard for the integrator's announce watermark.
 *
 * `resolveAnnouncementWatermark` is covered in
 * `sync/pot-git/integrator-announce-watermark.test.ts` and end-to-end in
 * `sync/pot-git/integrator-tick.integration.test.ts`. Neither can see the two
 * caller-side halves that make it work in production: `runIntegratorLeg` must
 * READ the watermark through the resolver, and must PERSIST the announced
 * staging into `metadata.integrator` for the next pass to read. Dropping either
 * restores the P-505 run 26 double announcement (same sha, seq 54 and seq 55).
 * `runIntegratorLeg` is internal and PG-coupled, so the pin reads its source,
 * scoped to the function body.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = process.env.INTEGRATOR_WATERMARK_WIRING_SOURCE ?? join(here, 'git-sync-action.ts');

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found in ${SOURCE_PATH}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\n\/\*\*/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('WI-10003781: runIntegratorLeg announces against its own announcement record', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const leg = functionBody(source, 'async function runIntegratorLeg(');

  it('reads the watermark through resolveAnnouncementWatermark, with the bridge watermark only as its fallback', () => {
    expect(leg).toMatch(/lastAnnouncedStagingSha:\s*resolveAnnouncementWatermark\(\s*prior,/);
    expect(leg).not.toMatch(/lastAnnouncedStagingSha:\s*rows\[0\]\?\.worktree_bridge/);
  });

  it('persists the announced staging into metadata.integrator', () => {
    const persist = leg.match(/'\{integrator\}',([\s\S]*?)::text::jsonb/);
    expect(persist, 'the metadata.integrator write must still exist').not.toBeNull();
    expect(persist![1]).toMatch(/stagingSha:\s*outcome\.announcement\.staging_sha/);
  });
});
