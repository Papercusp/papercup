import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../harness-registry';
import { readRegistry } from '../workspace-registry';
import { resolveDependencyGenerationRoot } from './dependency-generation-prebuild';

/** Run the existing prune-only publisher on stores discovered by the hourly janitor. */
export async function runDependencyGenerationRetention(): Promise<void> {
  try {
    const { resolveIntegrationRoot } = await import('../harness/routines/release-actions');
    const script = join(resolveIntegrationRoot(), 'apps/operator/bin/release/dependency-generation.sh');
    if (!existsSync(script)) return;
    const roots = new Map<string, string>();
    for (const workspace of readRegistry().workspaces) {
      try {
        const registry = await loadHarnessRegistry(workspace.id);
        for (const project of registry.projects) {
          const root = resolveHarnessContentPath(registry, project.slug);
          if (!root) continue;
          const generationRoot = resolveDependencyGenerationRoot(root);
          if (existsSync(generationRoot)) roots.set(root, generationRoot);
        }
      } catch (error) {
        console.warn(`[dependency-generation-retention] workspace ${workspace.id}: ${(error as Error).message}`);
      }
    }
    const run = promisify(execFile);
    for (const [root, generationRoot] of roots) {
      try {
        await run('bash', [script, '--integration', root, '--generation-root', generationRoot, '--prune-only'], {
          timeout: 120_000,
        });
      } catch (error) {
        console.warn(`[dependency-generation-retention] ${root}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    console.warn(`[dependency-generation-retention] tick failed: ${(error as Error).message}`);
  }
}
