/**
 * gen:compaction — render the Claude compaction floor (papercusp-compaction.base.md
 * + .claude.md overlay) via the SAME renderCompactionStrategy the install flow uses
 * (single source, no drift). With --check it validates the canonical compaction
 * source renders to a non-empty, marker-free body and exits non-zero otherwise — a
 * CI drift/validity gate. Without --check it prints the rendered strategy on stdout.
 * agent-managed-compaction-2026-07-01 (P-010).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCompactionStrategy } from '../packages/operator-core/lib/desktop-install/papercusp-files';

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const promptsDir = path.resolve(here, '../apps/operator/prompts');
  const check = process.argv.includes('--check');

  const out = await renderCompactionStrategy(promptsDir);
  if (!out) {
    console.error('[gen:compaction] FAILED — renders empty (missing papercusp-compaction.base.md?).');
    process.exit(1);
  }
  if (out.includes('PAPERCUSP-COMPACTION:CLIENT-OVERLAY')) {
    console.error('[gen:compaction] FAILED — the client-overlay marker survived (the overlay splice broke).');
    process.exit(1);
  }
  if (check) {
    console.log(`[gen:compaction] OK — canonical compaction source renders cleanly (${out.length} chars).`);
  } else {
    process.stdout.write(out + '\n');
  }
}

main().catch((e) => {
  console.error('[gen:compaction]', e instanceof Error ? e.message : e);
  process.exit(1);
});
