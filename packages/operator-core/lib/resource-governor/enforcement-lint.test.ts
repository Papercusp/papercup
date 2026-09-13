import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RESOURCE_GOVERNOR_INVENTORY,
  BYPASS_REGISTRY,
  P016_DISPOSITION_REGISTRY,
  RESOURCE_GOVERNOR_SCANNER_PATH,
  type ResourceGovernorInventoryRow,
  inspectGovernorSource,
  scanActiveInventory,
  scanInventory,
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
    expect(RESOURCE_GOVERNOR_INVENTORY.find((row) => row.id === 'mcp-http-operator-transport')?.enforcement).toBe(
      'active',
    );
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

  it('recognizes the canonical durable execution lifecycle at a process boundary', () => {
    expect(
      inspectGovernorSource(
        `const execution = await beginGovernedExecution(request, owner, runtime); const child = spawn('tsc', []); await execution.finish();`,
      ),
    ).not.toContain('resource-start-outside-admission');
  });

  it('detects called aliases bound to child-process starts without widening arbitrary names', () => {
    expect(
      inspectGovernorSource(`const spawnImpl = spawn; spawnImpl('agent-wrapper', [], { detached: true });`),
    ).toContain('resource-start-outside-admission');
    expect(
      inspectGovernorSource(`const exec = promisify(execFile); await exec('git', ['rev-parse', 'HEAD']);`),
    ).toContain('resource-start-outside-admission');
    expect(
      inspectGovernorSource(
        `const spawnImpl = spawn; await beginGovernedExecution(request, owner, runtime); spawnImpl('agent-wrapper', []);`,
      ),
    ).not.toContain('resource-start-outside-admission');
    expect(inspectGovernorSource(`const spawnRowKind = new Map(); spawnRowKind.set('x', 1);`)).not.toContain(
      'resource-start-outside-admission',
    );
  });

  it('does not count a caller-supplied callback named for a start verb as a start', () => {
    // A pacing/retry wrapper takes the operation as a callback and starts nothing
    // itself; the real child process is started by the caller it wraps, at a site
    // this same scan covers. Counting it here reports one start twice and pins it
    // on the file that does not make it.
    expect(
      inspectGovernorSource(
        `export async function withAgentSpawnPacing<T>(spawn: () => Promise<T>): Promise<T> { return await spawn(); }`,
      ),
    ).not.toContain('resource-start-outside-admission');
    expect(
      inspectGovernorSource(`const runner = { execFile: (): Promise<void> => done() }; await runner.execFile();`),
    ).not.toContain('resource-start-outside-admission');
  });

  it('still flags a real start in a file that also has a same-named callback parameter', () => {
    // The anti-launder case: the callback narrowing must not become a way to hide a
    // genuine child-process start behind a decoy parameter of the same name.
    expect(
      inspectGovernorSource(
        `import { spawn } from 'node:child_process'; function paced(spawn: () => void) { spawn(); } spawn('agent-wrapper', [], { detached: true });`,
      ),
    ).toContain('resource-start-outside-admission');
    // ...and a bare start with no local binding at all is untouched by the narrowing.
    expect(inspectGovernorSource(`spawn('agent-wrapper', [], { detached: true });`)).toContain(
      'resource-start-outside-admission',
    );
  });

  it('does not treat prose inside strings as executable resource-control code', () => {
    expect(inspectGovernorSource(`const guidance = 'waited for a semaphore slot';`)).toEqual([]);
    expect(inspectGovernorSource(`const guidance = 'call spawn(worker) next';`)).toEqual([]);
  });

  it.each([
    ['static capacity defaults', `const maxConcurrent = 4;`, 'hidden-or-static-capacity'],
    ['hidden semaphores', `const gate = new Semaphore(4);`, 'hidden-or-static-capacity'],
    ['resident queues', `pendingQueue.push(work);`, 'unbounded-resident-queue'],
    [
      'receipt retries',
      `await acquireWithContentionRetry(() => this.store.enqueue(candidate), { backoffsMs });`,
      'retry-around-receipt',
    ],
    ['missing lineage/release', `await governor.admit(input);`, 'missing-admission-context-or-release'],
    ['dishonest metrics', `const age = oldestAgeMs ?? 0;`, 'undefined-partial-or-stale-metric-coerced-to-zero'],
  ])('rejects %s', (_name, source, expected) => {
    expect(inspectGovernorSource(source)).toContain(expected);
  });

  it('requires a retry callback around the receipt-producing operation', () => {
    const declarationOnly = `
      type Options = {
        admissionRetryBackoffsMs?: readonly number[];
        sleep?: (ms: number) => Promise<void>;
        onActualDemand?: (input: { readonly receiptId: string }) => void;
      };
    `;
    expect(inspectGovernorSource(declarationOnly)).not.toContain('retry-around-receipt');
    expect(
      inspectGovernorSource(`await retry(async () => { await receiptStore.enqueue(candidate); });`),
    ).toContain('retry-around-receipt');
    expect(inspectGovernorSource(`await retry(async () => { await performWork(); }, { receiptId });`)).not.toContain(
      'retry-around-receipt',
    );
  });

  it('matches the real queue retry site and not its adjacent option declarations', () => {
    const queueSource = readFileSync(ROOT + 'packages/operator-core/lib/resource-governor/queue.ts', 'utf8');
    const declarationStart = queueSource.indexOf('private readonly onActualDemand:');
    const admitStart = queueSource.indexOf('async admit(');
    const retryStart = queueSource.indexOf('stored = await acquireWithContentionRetry(');
    const retryEnd = queueSource.indexOf('    } catch (error)', retryStart);
    expect(declarationStart).toBeGreaterThanOrEqual(0);
    expect(admitStart).toBeGreaterThan(declarationStart);
    expect(retryStart).toBeGreaterThan(admitStart);
    expect(retryEnd).toBeGreaterThan(retryStart);
    expect(inspectGovernorSource(queueSource.slice(declarationStart, admitStart))).not.toContain(
      'retry-around-receipt',
    );
    expect(inspectGovernorSource(queueSource.slice(retryStart, retryEnd))).toContain(
      'retry-around-receipt',
    );
  });

  it('does not treat pending diagnostic IDs as a resident queue', () => {
    expect(
      inspectGovernorSource(
        `const pendingGradingAuditTargetIds = new Set<string>(); pendingGradingAuditTargetIds.add(issueId);`,
      ),
    ).not.toContain('unbounded-resident-queue');
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

  it('requires an explicit reviewed disposition for every active P-016 finding and excludes only scanner self-code', () => {
    const { files } = listTrackedFiles(ROOT);
    const p016Rows = RESOURCE_GOVERNOR_INVENTORY.filter((row) => row.migration === 'P-016');
    const p016Files: Array<[string, string]> = [];
    for (const path of files) {
      if (!/\.(?:ts|tsx|mts|mjs)$/.test(path) || /\.(?:test|spec)\./.test(path) || path.includes('/_retired/'))
        continue;
      if (!p016Rows.some((row) => row.paths.some((prefix) => path.startsWith(prefix)))) continue;
      p016Files.push([path, readFileSync(`${ROOT}${path}`, 'utf8')]);
    }
    const observed = new Set<string>();
    for (const [path, source] of p016Files) {
      if (path === RESOURCE_GOVERNOR_SCANNER_PATH) continue;
      for (const code of inspectGovernorSource(source)) observed.add(`${path}::${code}`);
    }
    expect(observed.size).toBeGreaterThan(100);
    expect(P016_DISPOSITION_REGISTRY.size).toBe(observed.size);
    expect(new Set([...P016_DISPOSITION_REGISTRY.values()].map((entry) => entry.reason)).size).toBe(
      P016_DISPOSITION_REGISTRY.size,
    );
    for (const key of observed) {
      const entry = P016_DISPOSITION_REGISTRY.get(key);
      expect(entry).toBeDefined();
      expect(['bypass', 'semantic', 'upstream']).toContain(entry?.disposition);
      expect(entry?.reason).toMatch(/P-016 reviewed/);
      expect(BYPASS_REGISTRY.has(key)).toBe(true);
    }
    expect(
      scanInventory([[RESOURCE_GOVERNOR_SCANNER_PATH, `if (receipt.state === 'queued') retryAgain();`]], {
        migrations: ['P-016'],
      }),
    ).toEqual([]);
    expect(
      scanInventory([['packages/operator-core/lib/p2p/new-unreviewed.ts', `spawn('worker', []);`]], {
        migrations: ['P-016'],
      }),
    ).toEqual(['packages/operator-core/lib/p2p/new-unreviewed.ts:resource-start-outside-admission']);
  }, 60_000);

  it('keeps the hand-written .d.mts declaration aligned with the P-016 runtime exports', () => {
    const declaration = readFileSync(ROOT + 'scripts/check-resource-governor-enforcement.d.mts', 'utf8');
    for (const symbol of [
      'RESOURCE_GOVERNOR_SCANNER_PATH',
      'P016_REVIEWED_DISPOSITIONS',
      'P016_DISPOSITION_REGISTRY',
    ]) {
      expect(declaration).toContain('export const ' + symbol);
    }
    expect(declaration).toContain('migration: string;');
    expect(declaration).toContain('sites: readonly');
  });

  it('can audit a pending migration and applies only centrally registered dispositions', () => {
    const files: Array<[string, string]> = [
      [
        'packages/operator-core/lib/agent-tools/plans/audit.ts',
        `import { execFileSync } from 'node:child_process'; execFileSync('git', ['rev-parse', 'HEAD']);`,
      ],
      [
        'packages/operator-core/lib/agent-tools/example.ts',
        `import { spawn } from 'node:child_process'; spawn('resident-worker', []);`,
      ],
    ];

    expect(scanInventory(files, { migrations: ['P-014'] })).toEqual([
      'packages/operator-core/lib/agent-tools/example.ts:resource-start-outside-admission',
    ]);
    expect(scanActiveInventory(files)).toEqual([
      'packages/operator-core/lib/agent-tools/example.ts:resource-start-outside-admission',
    ]);
  });

  it('rejects a stale exact bypass entry once its registered path no longer has that finding', () => {
    const files: Array<[string, string]> = [
      ['packages/operator-core/lib/agent-tools/plans/audit.ts', `export const head = 'already supplied';`],
    ];
    expect(scanInventory(files, { migrations: ['P-014'], validateRegistry: true })).toContain(
      'stale-bypass-registry:packages/operator-core/lib/agent-tools/plans/audit.ts::resource-start-outside-admission:finding-absent',
    );
  });

  it('limits the completion metadata disposition to the reviewed bounded Git probe', () => {
    const path = 'packages/operator-core/lib/agent-tools/work_items/complete.ts';
    const source = readFileSync(ROOT + path, 'utf8');
    const finding = `${path}:resource-start-outside-admission`;
    expect(inspectGovernorSource(source)).toContain('resource-start-outside-admission');
    expect(scanInventory([[path, source]])).not.toContain(finding);
    expect(scanInventory([[path, source + "\nspawn('resident-worker', []);"]])).toContain(finding);
    expect(scanInventory([[path, source + "\nconst childStart = spawn; childStart('worker', []);"]])).toContain(finding);
    for (const [before, after] of [
      ["'ls-files'", "'checkout'"],
      ['timeout: 5_000', 'timeout: 0'],
      ["killSignal: 'SIGKILL'", "killSignal: 'SIGTERM'"],
      ["stdio: ['ignore', 'ignore', 'ignore']", "stdio: ['ignore', 'pipe', 'pipe']"],
    ]) {
      expect(source).toContain(before);
      const mutant = source.replace(before, after);
      expect(mutant).not.toBe(source);
      expect(scanInventory([[path, mutant]])).toContain(finding);
    }
  });

  it('executes the real blocking CLI over the tracked tree', () => {
    const output = execFileSync(process.execPath, ['scripts/check-resource-governor-enforcement.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(output).toContain('[resource-governor-enforcement] OK');
  }, 30_000);
});
