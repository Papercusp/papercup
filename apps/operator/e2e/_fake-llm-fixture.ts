import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

// Register a real harness only in the maintained disposable rig. The chat
// tools resolve their project before entering the fake model seam.
export async function seedFakeLlmHarness(): Promise<string> {
  if (process.env.VERIFY_TAURI_ISOLATED_DB !== '1') return 'main';
  const root = process.env.OPERATOR_SOURCE_ROOT;
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID;
  const admin = process.env.HARNESS_ADMIN_DATABASE_URL;
  if (!root || !workspace?.startsWith('verify-tauri-isolated-') || !admin) throw new Error('Missing isolated chat fixture context');
  const database = new URL(admin);
  if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !database.port || database.port === '5432') throw new Error('Refusing shared chat fixture database');
  await promisify(execFile)(process.execPath, [
    '--import', resolve(root, 'scripts/lib/committed-source-loader.mjs'),
    '--import', 'tsx', '--input-type=module', '-e',
    `const { loadHarnessRegistry } = await import('./packages/operator-core/lib/harness-registry.ts');
     const ws = process.env.PAPERCUSP_WORKSPACE_ID;
     const reg = await loadHarnessRegistry(ws);
     const { getOrgPg } = await import('@papercusp/db-org');
     const { sql } = getOrgPg();
     try {
       // Fixture writes use the existing registry storage contract and its PG
       // invalidation trigger. The product save path also imports the live
       // notification graph, which took 42s in a fresh isolated child.
       const payload = { ...reg, projects: [...reg.projects.filter(p => p.slug !== 'e2e-fake-chat'), { slug: 'e2e-fake-chat', path: process.cwd() }] };
       await sql.unsafe('INSERT INTO harness_shared.harness_registry (workspace_id, payload, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at', [ws, JSON.stringify(payload), Date.now()]);
       const rows = await sql.unsafe('SELECT payload FROM harness_shared.harness_registry WHERE workspace_id = $1', [ws]);
       if (!rows[0]?.payload?.projects?.some(p => p.slug === 'e2e-fake-chat' && p.path === process.cwd())) throw new Error('Chat fixture registry write was not retained');
     } finally { await sql.end(); }`,
  ], { cwd: root, env: { ...process.env, DATABASE_URL: admin }, timeout: 30_000 });
  return 'e2e-fake-chat';
}
