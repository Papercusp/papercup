import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../harness-registry';
import { runGovernedOperation } from '../resource-governor/execution';
import { readRegistry } from '../workspace-registry';
import { resolveDependencyGenerationRetentionRoots } from './dependency-generation-prebuild';

/** Run the existing prune-only publisher on stores discovered by the hourly janitor. */
export async function runDependencyGenerationRetention(): Promise<void> {
  try {
    const { resolveIntegrationRoot } = await import('../harness/routines/release-actions');
    const script = join(resolveIntegrationRoot(), 'apps/operator/bin/release/dependency-generation.sh');
    if (!existsSync(script)) return;
    // A shared integration root is swept once; the first workspace that registers it owns
    // the admission receipt for that prune.
    const roots = new Map<string, { generationRoots: string[]; workspaceId: string }>();
    for (const workspace of readRegistry().workspaces) {
      try {
        const registry = await loadHarnessRegistry(workspace.id);
        for (const project of registry.projects) {
          const root = resolveHarnessContentPath(registry, project.slug);
          if (!root || roots.has(root)) continue;
          const generationRoots = resolveDependencyGenerationRetentionRoots(root);
          // A missing replacement is not proof an older store may be retired.
          if (existsSync(generationRoots[0]!)) roots.set(root, { generationRoots, workspaceId: workspace.id });
        }
      } catch (error) {
        console.warn(`[dependency-generation-retention] workspace ${workspace.id}: ${(error as Error).message}`);
      }
    }
    const run = promisify(execFile);
    for (const [root, { generationRoots, workspaceId }] of roots) {
      for (const [index, generationRoot] of generationRoots.entries()) {
        if (!existsSync(generationRoot)) continue;
        try {
          // Each prune retains governed admission, including former stores.
          await runGovernedOperation(
            {
              workspaceId,
              namespace: 'dependency-generation-retention',
              owner: 'dependency-generation-retention',
              admissionClass: 'process',
              demand: { cpuWeight: 0.5, memoryBytes: 128 * 1024 * 1024, fileDescriptors: 3 },
              payloadRef: `dependency-generation-retention:${root}${index ? `:${generationRoot}` : ''}`,
              metadata: { command: 'dependency-generation.sh --prune-only', generationRoot, retired: index > 0 },
            },
            async () =>
              run('bash', [script, '--integration', root, '--generation-root', generationRoot, '--prune-only',
                ...(index ? ['--retired-store'] : [])], {
                timeout: 120_000,
              }),
          );
        } catch (error) {
          console.warn(`[dependency-generation-retention] ${root}: ${(error as Error).message}`);
        }
      }
    }
  } catch (error) {
    console.warn(`[dependency-generation-retention] tick failed: ${(error as Error).message}`);
  }
}
