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
    `const { loadHarnessRegistry, saveHarnessRegistry } = await import('./packages/operator-core/lib/harness-registry.ts');
     const ws = process.env.PAPERCUSP_WORKSPACE_ID;
     const reg = await loadHarnessRegistry(ws);
     await saveHarnessRegistry({ ...reg, projects: [...reg.projects.filter(p => p.slug !== 'e2e-fake-chat'), { slug: 'e2e-fake-chat', path: process.cwd() }] }, ws);
     const { getOrgPg } = await import('@papercusp/db-org');
     await getOrgPg().sql.end();`,
  ], { cwd: root, env: { ...process.env, DATABASE_URL: admin }, timeout: 30_000 });
  return 'e2e-fake-chat';
}
