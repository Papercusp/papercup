import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../harness-registry';
import { runGovernedOperation } from '../resource-governor/execution';
import { readRegistry } from '../workspace-registry';
import { resolveDependencyGenerationRetentionRoots } from './dependency-generation-root';

export interface DependencyRetentionReport {
  schemaVersion: 1;
  status: 'complete' | 'partial' | 'unavailable';
  skippedIntegrations: Array<{ root: string; reason: string }>;
  stores: Array<{
    integrationRoot: string;
    generationRoot: string;
    retired: boolean;
    status: 'pruned' | 'failed';
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    error?: string;
    exitCode?: string | number | null;
    signal?: string | null;
  }>;
  errors: Array<{ scope: string; error: string }>;
}

function outputReceipt(stdout: unknown, stderr: unknown) {
  const out = String(stdout ?? '');
  const err = String(stderr ?? '');
  return { stdout: out.slice(-4096), stderr: err.slice(-4096), stdoutTruncated: out.length > 4096, stderrTruncated: err.length > 4096 };
}

/** Run the existing prune-only publisher and preserve its exact bounded receipts. */
export async function runDependencyGenerationRetention(): Promise<DependencyRetentionReport> {
  const report: DependencyRetentionReport = { schemaVersion: 1, status: 'complete', skippedIntegrations: [], stores: [], errors: [] };
  try {
    const { resolveIntegrationRoot, readFrozenCandidateRepairQueueState } = await import('../harness/routines/release-actions');
    const script = join(resolveIntegrationRoot(), 'apps/operator/bin/release/dependency-generation.sh');
    if (!existsSync(script)) return { ...report, status: 'unavailable', errors: [{ scope: script, error: 'maintained script is absent' }] };
    const seenRoots = new Set<string>();
    const stores = new Map<string, { root: string; generationRoot: string; retired: boolean; workspaceId: string }>();
    const frozenRefs = new Map<string, Set<string>>();
    const unsafeRoots = new Set<string>();
    for (const workspace of readRegistry().workspaces) {
      try {
        const registry = await loadHarnessRegistry(workspace.id);
        for (const project of registry.projects) {
          let root = resolveHarnessContentPath(registry, project.slug);
          if (!root) continue;
          // Environment configuration can name a live shared store even for a
          // long-retired /tmp project. The shell requires a real integration.
          if (!existsSync(root) || !statSync(root).isDirectory()) {
            report.skippedIntegrations.push({ root, reason: 'integration is absent or not a directory' });
            continue;
          }
          // The shell records physical integration roots in pins. Merge alias
          // consumers before syncing, so one alias cannot release another's refs.
          root = realpathSync(root);
          // Retention follows durable queue custody, not the age of a ref pin.
          // An unreadable queue must never be interpreted as permission to prune.
          frozenRefs.set(root, frozenRefs.get(root) ?? new Set<string>());
          try {
            const queue = await readFrozenCandidateRepairQueueState({ workspaceId: workspace.id, installSlug: project.slug });
            if (queue.status !== 'value' && queue.status !== 'absent') throw new Error('frozen repair queue is unreadable');
            const refs = frozenRefs.get(root) ?? new Set<string>();
            if (queue.status === 'value') {
              refs.add(queue.queue.candidate);
              refs.add(queue.queue.repairHead);
            }
            frozenRefs.set(root, refs);
          } catch (error) {
            unsafeRoots.add(root);
            report.errors.push({ scope: root, error: `cannot establish frozen dependency custody: ${(error as Error).message}` });
          }
          if (seenRoots.has(root)) continue;
          seenRoots.add(root);
          const generationRoots = resolveDependencyGenerationRetentionRoots(root);
          // A missing replacement is not proof an older store may be retired.
          if (!existsSync(generationRoots[0]!)) {
            report.skippedIntegrations.push({ root, reason: 'selected store is absent' });
            continue;
          }
          for (const [index, generationRoot] of generationRoots.entries()) {
            if (!existsSync(generationRoot)) continue;
            const key = realpathSync(generationRoot);
            const retired = index > 0;
            const prior = stores.get(key);
            // One physical store is swept once. A current reference anywhere
            // retains normal recency protection instead of retiring that store.
            if (!prior || (prior.retired && !retired)) {
              stores.set(key, { root, generationRoot, retired, workspaceId: workspace.id });
            }
          }
        }
      } catch (error) {
        const message = (error as Error).message;
        report.errors.push({ scope: `workspace ${workspace.id}`, error: message });
        console.warn(`[dependency-generation-retention] workspace ${workspace.id}: ${message}`);
      }
    }
    const run = promisify(execFile);
    for (const { root, generationRoot, retired, workspaceId } of stores.values()) {
      try {
        const consumers = [...frozenRefs].filter(([consumer]) =>
          resolveDependencyGenerationRetentionRoots(consumer).some((store) => existsSync(store) && realpathSync(store) === realpathSync(generationRoot)));
        if (consumers.some(([consumer]) => unsafeRoots.has(consumer))) throw new Error('frozen dependency custody is unknown; store retained');
        // Each prune retains governed admission, including former stores.
        const result = await runGovernedOperation(
          {
            workspaceId,
            namespace: 'dependency-generation-retention',
            owner: 'dependency-generation-retention',
            admissionClass: 'process',
            demand: { cpuWeight: 0.5, memoryBytes: 128 * 1024 * 1024, fileDescriptors: 3 },
            payloadRef: `dependency-generation-retention:${root}${retired ? `:${generationRoot}` : ''}`,
            metadata: { command: 'dependency-generation.sh --prune-only', generationRoot, retired },
          },
          async () => {
            for (const [consumer, refs] of consumers) {
              const pins = join(generationRoot, '.pins');
              const hasFrozenPins = existsSync(pins) && readdirSync(pins).some((name) =>
                readFileSync(join(pins, name), 'utf8').includes('retention=frozen\n'));
              if (refs.size === 0 && !hasFrozenPins) continue;
              await run('bash', [script, '--integration', consumer, '--generation-root', generationRoot,
                '--sync-frozen-refs', ...[...refs].flatMap((ref) => ['--frozen-ref', ref])], { timeout: 120_000 });
            }
            return run('bash', [script, '--integration', root, '--generation-root', generationRoot, '--prune-only', '--no-recorded-store-cascade',
              ...(retired ? ['--retired-store'] : [])], {
              timeout: 120_000,
            });
          },
        );
        report.stores.push({ integrationRoot: root, generationRoot, retired, status: 'pruned', ...outputReceipt(result.stdout, result.stderr) });
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number; signal?: string };
        report.stores.push({ integrationRoot: root, generationRoot, retired, status: 'failed',
          error: failure.message.slice(0, 2000), exitCode: failure.code ?? null, signal: failure.signal ?? null,
          ...outputReceipt(failure.stdout, failure.stderr) });
        console.warn(`[dependency-generation-retention] ${root}: ${failure.message}`);
      }
    }
  } catch (error) {
    const message = (error as Error).message;
    report.errors.push({ scope: 'tick', error: message });
    console.warn(`[dependency-generation-retention] tick failed: ${message}`);
  }
  if (report.errors.length || report.stores.some((store) => store.status === 'failed')) report.status = 'partial';
  return report;
}
