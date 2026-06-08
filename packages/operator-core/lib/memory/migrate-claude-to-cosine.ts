/**
 * migrate-claude-to-cosine — one-time migration that populates the canonical
 * (cosine/mem0) leg of the hybrid from the owner's Claude file memory, so the
 * hybrid recalls the same facts semantically (cosine) AND lexically (the files).
 *
 *   npx tsx packages/operator-core/lib/memory/migrate-claude-to-cosine.ts            # dry-run
 *   npx tsx packages/operator-core/lib/memory/migrate-claude-to-cosine.ts --execute  # write
 *
 * The ~/.claude files are read-only here (kept exactly as-is); each fact is
 * remembered VERBATIM into the cosine store under the owner scope, so the
 * hybrid's text-key dedup collapses the two legs' copies into one on recall.
 * Idempotent: skips a fact already present verbatim in the owner's cosine scope.
 */
import os from 'node:os';
import { ClaudeFileMemoryBackend, Mem0Backend, claudeProjectMemoryDir } from '@papercusp/memory';
import { getOrgPg } from '@papercusp/db-org';
import './configure'; // side-effect: wires the REAL operator memory host (harness_shared schema + the embedder cascade)

const execute = process.argv.includes('--execute');
const norm = (t: string): string => t.trim().replace(/\s+/g, ' ');

async function main() {
  const { sql } = getOrgPg();
  const owner = await sql<{ id: string }[]>`SELECT id FROM harness_shared.users WHERE username = 'default' AND is_active = true LIMIT 1`;
  if (!owner.length) throw new Error('default user not found');
  const ownerId = owner[0].id;
  console.log(`owner scope: ${ownerId}`);

  const lexical = new ClaudeFileMemoryBackend({ memoryDir: claudeProjectMemoryDir(os.homedir(), `${os.homedir()}/.claude`) });
  const avail = await lexical.available();
  if (!avail.ok) throw new Error(`claude-file leg unavailable: ${avail.reason}`);
  const entries = await lexical.list({ scope: ownerId });
  console.log(`claude-file memories to migrate: ${entries.length}`);

  const cosine = new Mem0Backend();
  // Existing verbatim texts already in the owner's cosine scope (idempotency).
  const existing = new Set<string>((await cosine.list({ scope: ownerId })).map((e) => norm(e.text)));
  console.log(`already in cosine (owner scope): ${existing.size}`);

  let migrated = 0, skipped = 0, failed = 0;
  for (const e of entries) {
    const text = e.text?.trim();
    if (!text) { skipped++; continue; }
    if (existing.has(norm(text))) { skipped++; continue; }
    if (!execute) { migrated++; continue; }
    try {
      await cosine.remember(text, {
        scope: ownerId,
        verbatim: true,
        kind: e.kind,
        metadata: {
          source: 'claude-file-migration',
          ...(typeof e.metadata?.file === 'string' ? { orig_file: e.metadata.file } : {}),
          ...(typeof e.metadata?.description === 'string' ? { description: e.metadata.description } : {}),
        },
      });
      migrated++;
      if (migrated % 25 === 0) console.log(`  …${migrated} migrated`);
    } catch (err) {
      failed++;
      console.log(`  ! failed: ${(e.metadata?.file as string) ?? e.id}: ${(err as Error).message.slice(0, 90)}`);
    }
  }
  console.log(`\n${execute ? 'MIGRATED' : 'DRY-RUN (would migrate)'}: ${migrated}  skipped(existing/empty): ${skipped}  failed: ${failed}`);
  if (!execute) console.log('re-run with --execute to write.');
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
