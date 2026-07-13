/** Throwaway: what does console-launcher SEE when it resolves a workspace-only cwd? */
import { loadHarnessRegistry } from '../packages/operator-core/lib/harness-registry';
import { papercuspPathForWorkspace } from '../packages/operator-core/lib/papercusp-root';

async function main() {
  const ws = process.env.PAPERCUSP_WORKSPACE || '';
  const reg = await loadHarnessRegistry(ws);
  const rows = reg.projects.map((p) => ({
    slug: p.slug,
    path: p.path,
    kind: p.harness_kind ?? '',
    self_repo: !!p.self_repo,
    hive_slug: p.hive_slug ?? '',
  }));
  console.log('workspace:', ws);
  console.log('current no-slug cwd (the bug):', papercuspPathForWorkspace(ws));
  console.log('');
  console.log('candidates whose path looks like the main checkout:');
  for (const r of rows) {
    if (/papercusp|papercup/.test(r.slug)) {
      console.log(`  ${r.slug.padEnd(12)} kind=${r.kind.padEnd(10)} self_repo=${r.self_repo}  path=${r.path}`);
    }
  }
  console.log('');
  console.log('all self_repo harnesses:', rows.filter((r) => r.self_repo).map((r) => r.slug));
  console.log("all kind='hive' harnesses:", rows.filter((r) => r.kind === 'hive').map((r) => r.slug));
  console.log('total projects:', rows.length);
}
void main();
