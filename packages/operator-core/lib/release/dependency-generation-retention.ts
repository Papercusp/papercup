import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../harness-registry';
import { runGovernedOperation } from '../resource-governor/execution';
import { readRegistry } from '../workspace-registry';
import { resolveDependencyGenerationRoot } from './dependency-generation-prebuild';

/** Run the existing prune-only publisher on stores discovered by the hourly janitor. */
export async function runDependencyGenerationRetention(): Promise<void> {
  try {
    const { resolveIntegrationRoot } = await import('../harness/routines/release-actions');
    const script = join(resolveIntegrationRoot(), 'apps/operator/bin/release/dependency-generation.sh');
    if (!existsSync(script)) return;
    // A shared integration root is swept once; the first workspace that registers it owns
    // the admission receipt for that prune.
    const roots = new Map<string, { generationRoot: string; workspaceId: string }>();
    for (const workspace of readRegistry().workspaces) {
      try {
        const registry = await loadHarnessRegistry(workspace.id);
        for (const project of registry.projects) {
          const root = resolveHarnessContentPath(registry, project.slug);
          if (!root || roots.has(root)) continue;
          const generationRoot = resolveDependencyGenerationRoot(root);
          if (existsSync(generationRoot)) roots.set(root, { generationRoot, workspaceId: workspace.id });
        }
      } catch (error) {
        console.warn(`[dependency-generation-retention] workspace ${workspace.id}: ${(error as Error).message}`);
      }
    }
    const run = promisify(execFile);
    for (const [root, { generationRoot, workspaceId }] of roots) {
      try {
        // WI-10007542: each prune is a real child-process start on the hourly janitor, so it
        // waits for governed admission like every other runtime start rather than running
        // beside it unmetered. A refused or failed admission skips only this root.
        await runGovernedOperation(
          {
            workspaceId,
            namespace: 'dependency-generation-retention',
            owner: 'dependency-generation-retention',
            admissionClass: 'process',
            demand: { cpuWeight: 0.5, memoryBytes: 128 * 1024 * 1024, fileDescriptors: 3 },
            payloadRef: `dependency-generation-retention:${root}`,
            metadata: { command: 'dependency-generation.sh --prune-only' },
          },
          async () =>
            run('bash', [script, '--integration', root, '--generation-root', generationRoot, '--prune-only'], {
              timeout: 120_000,
            }),
        );
      } catch (error) {
        console.warn(`[dependency-generation-retention] ${root}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    console.warn(`[dependency-generation-retention] tick failed: ${(error as Error).message}`);
  }
}
