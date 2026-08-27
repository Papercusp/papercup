import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RESOURCE_GOVERNOR_INVENTORY,
  type ResourceGovernorInventoryRow,
  inspectGovernorSource,
  scanActiveInventory,
  validateInventory,
} from '../../../../scripts/check-resource-governor-enforcement.mjs';
import { listTrackedFiles } from '../../../../scripts/lib/tracked-files.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('resource governor enforcement lint', () => {
  it('seeds every subsystem lane and gives each one complete, reviewable writer evidence', () => {
    expect(RESOURCE_GOVERNOR_INVENTORY.map((row) => row.id)).toEqual([
      'agent-process-memory',
      'mcp-http-operator-transport',
      'inference-embedding-provider-batching',
      'database-sidecar-checkpoint-dbos',
      'p2p-sync-index-cache-compaction',
      'ci-release-test-workers',
      'background-routines-watchdogs',
      'governor-core',
    ]);
    expect(validateInventory()).toEqual([]);
  });

  it('rejects a resource start outside Governor.admit or a valid lease', () => {
    expect(inspectGovernorSource(`import { spawn } from 'node:child_process'; spawn('x', []);`)).toContain(
      'resource-start-outside-admission',
    );
    expect(
      inspectGovernorSource(
        `await governor.admit(input); const context: AdmissionContext = input.context; await governor.release(context); spawn('x', []);`,
      ),
    ).not.toContain('resource-start-outside-admission');
  });

  it.each([
    ['static capacity defaults', `const maxConcurrent = 4;`, 'hidden-or-static-capacity'],
    ['hidden semaphores', `const gate = new Semaphore(4);`, 'hidden-or-static-capacity'],
    ['resident queues', `pendingQueue.push(work);`, 'unbounded-resident-queue'],
    ['receipt retries', `if (receipt.state === 'queued') retryAgain();`, 'retry-around-receipt'],
    ['missing lineage/release', `await governor.admit(input);`, 'missing-admission-context-or-release'],
    ['dishonest metrics', `const age = oldestAgeMs ?? 0;`, 'undefined-partial-or-stale-metric-coerced-to-zero'],
  ])('rejects %s', (_name, source, expected) => {
    expect(inspectGovernorSource(source)).toContain(expected);
  });

  it('allows physical upstream constraints only when the writer carries explicit evidence', () => {
    // Annotated so `disposition` keeps its literal type: an un-annotated array literal
    // widens it to `string`, which stopped satisfying ResourceGovernorInventoryRow once
    // that field became a union.
    const rows: readonly Partial<ResourceGovernorInventoryRow>[] = [
      { ...RESOURCE_GOVERNOR_INVENTORY[0], id: 'provider-limit', disposition: 'upstream', writerEvidence: '' },
    ];
    expect(validateInventory(rows)).toContain('inventory-writer-evidence:provider-limit');
    expect(
      validateInventory([{ ...rows[0], writerEvidence: 'provider contract constraint evidence required at writer' }]),
    ).toEqual([]);
  });

  it('runs the active enforcement lane over the real tracked tree', () => {
    const { files } = listTrackedFiles(ROOT);
    const sourceFiles: Array<[string, string]> = [];
    for (const path of files) {
      if (!path.startsWith('packages/operator-core/lib/resource-governor/') || /\.(?:test|spec)\./.test(path)) continue;
      sourceFiles.push([path, readFileSync(`${ROOT}${path}`, 'utf8')]);
    }
    expect(sourceFiles.length).toBeGreaterThan(5);
    expect(scanActiveInventory(sourceFiles)).toEqual([]);
  });

  it('executes the real blocking CLI over the tracked tree', () => {
    const output = execFileSync(process.execPath, ['scripts/check-resource-governor-enforcement.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(output).toContain('[resource-governor-enforcement] OK');
  });
});
