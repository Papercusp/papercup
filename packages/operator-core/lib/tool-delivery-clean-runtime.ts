/** D085: admission and completion guards for a prospective clean tool-delivery cohort.
 * Reuses the actual test recorder and frozen experiment population; never repairs a receipt.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RecordedLlmBlockCustody } from '@papercusp/test-config/execution-details';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));
export interface ToolDeliveryCleanBoundary {
  sourceRoot: string;
  commit: string | null;
  porcelain: string | null;
  stagedDiff: string;
  unstagedDiff: string;
  submoduleStatus: string;
  untracked: string[];
  ignoredCensusSha256: string;
  disallowedIgnoredFiles: string[];
  sourceHashes: Record<string, string>;
  moduleHashes: Record<string, string>;
  installSha256: string;
  environmentSha256: string;
  executableSha256: string;
  nodeVersion: string;
  loadedBuildSha: string;
  configGenerationSha256: string;
  pid: number;
  processStartTicks: string;
  sut: { transport: 'in-process'; pid: number; processStartTicks: string };
  cwd: string;
  monotonicNs: string;
}
export type ToolDeliveryCleanPin = Omit<ToolDeliveryCleanBoundary,
  'pid' | 'processStartTicks' | 'sut' | 'monotonicNs'>;

export interface ToolDeliveryCleanRegistration {
  sourcePins: { files: Record<string, string>; scenarioPaths: Record<string, string> };
  measurementAmendment?: { sourceReplacements: Record<string, unknown>; addedFiles: Record<string, string> };
  executionPolicy?: { launcherPath?: string };
}
const recorder = 'packages/operator-core/lib/llm-testing/test-run-ledger.ts';
const providers = ['packages/operator-core/lib/llm-testing/targets/su.ts',
  'packages/operator-core/lib/llm-testing/targets/codex-responses-tool-loop.ts'];
const loader = 'node_modules/tsx/dist/loader.mjs';
export function toolDeliveryMandatorySources(registration: ToolDeliveryCleanRegistration): string[] {
  const launcher = registration.executionPolicy?.launcherPath;
  if (!launcher || isAbsolute(launcher) || launcher.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('A committed repository-relative launcher must be preregistered.');
  return [...new Set([...Object.keys(registration.sourcePins.files), ...Object.values(registration.sourcePins.scenarioPaths),
    ...Object.keys(registration.measurementAmendment?.sourceReplacements ?? {}),
    ...Object.keys(registration.measurementAmendment?.addedFiles ?? {}), recorder, ...providers, launcher, loader])].sort();
}
export function validateToolDeliveryCleanCensus(boundary: ToolDeliveryCleanBoundary,
  registration: ToolDeliveryCleanRegistration): string | undefined {
  const required = toolDeliveryMandatorySources(registration);
  if (digest(Object.keys(boundary.sourceHashes).sort()) !== digest(required)) return 'Mandatory source census is incomplete or extended.';
  for (const path of [recorder, ...providers, loader, registration.executionPolicy!.launcherPath!])
    if (!(path in boundary.moduleHashes)) return 'Mandatory loaded module is absent.';
}

/** Resolve symlinks before checking containment. Built-ins alone need no file proof. */
export function toolDeliveryModuleFile(sourceRoot: string, url: string): string | null {
  if (url.startsWith('node:')) return null;
  if (!url.startsWith('file:')) throw new Error('tool-delivery module has no local source identity');
  const root = realpathSync(sourceRoot);
  const path = realpathSync(fileURLToPath(url));
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('tool-delivery module escaped the retained source checkout');
  return path;
}

/** Install BEFORE importing the recorder, provider loops or scenario graph.
 * The launcher must also pin its own entrypoint and locally installed TS loader.
 * Refreshing the returned census rehashes dependency bytes at every boundary.
 */
export function installToolDeliveryModuleGuard(sourceRoot: string): { urls: Set<string>; deregister(): void } {
  const urls = new Set<string>();
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (toolDeliveryModuleFile(sourceRoot, result.url)) urls.add(result.url);
      return result;
    },
  });
  return { urls, deregister: () => hooks.deregister() };
}

/** `moduleUrls` comes from the runner's Node resolve hook, including dependency imports.
 * Missing install manifests or unreadable Git/process evidence throw before model admission.
 * Environment values are hashed here and are never returned in receipts.
 */
export async function captureToolDeliveryCleanBoundary(input: {
  sourceRoot: string; registration: ToolDeliveryCleanRegistration; moduleUrls: readonly string[];
}): Promise<ToolDeliveryCleanBoundary> {
  const { captureWorktreeSnapshot } = await import('./testing-worktree');
  const root = realpathSync(input.sourceRoot);
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
  const snapshot = captureWorktreeSnapshot(root);
  const sourceHashes: Record<string, string> = {};
  for (const path of toolDeliveryMandatorySources(input.registration)) {
    if (isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('tool-delivery source pin must be repository relative');
    const actual = toolDeliveryModuleFile(root, pathToFileURL(resolve(root, path)).href)!;
    sourceHashes[path] = hash(readFileSync(actual));
  }
  const moduleHashes: Record<string, string> = {};
  for (const url of [...new Set(input.moduleUrls)].sort()) {
    const file = toolDeliveryModuleFile(root, url);
    if (file) moduleHashes[relative(root, file).split(sep).join('/')] = hash(readFileSync(file));
  }
  const status = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  // comm may contain spaces or parentheses; field 3 follows its LAST closing paren.
  const processStartTicks = status.slice(status.lastIndexOf(')') + 2).split(' ')[19]!;
  const installSha256 = digest(['package-lock.json', 'node_modules/.package-lock.json']
    .map(path => [path, hash(readFileSync(resolve(root, path)))]));
  const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  // Installed dependencies are the only admitted ignored inputs. Source-local
  // config/cache roots require an explicit future policy amendment.
  const disallowedIgnoredFiles = ignored.filter(path => !path.split('/').includes('node_modules'));
  const environmentSha256 = digest(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)));
  return { sourceRoot: root, ...snapshot,
    stagedDiff: git(['diff', '--cached', '--name-status']),
    unstagedDiff: git(['diff', '--name-status']),
    submoduleStatus: git(['submodule', 'status', '--recursive']),
    untracked: git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort(),
    ignoredCensusSha256: digest(ignored), disallowedIgnoredFiles,
    sourceHashes, moduleHashes, installSha256,
    environmentSha256, loadedBuildSha: snapshot.commit ?? '', configGenerationSha256: environmentSha256,
    executableSha256: hash(readFileSync(realpathSync(process.execPath))), nodeVersion: process.version,
    pid: process.pid, processStartTicks,
    sut: { transport: 'in-process', pid: process.pid, processStartTicks },
    cwd: realpathSync(process.cwd()), monotonicNs: process.hrtime.bigint().toString() };
}

export function validateToolDeliveryCleanBoundary(actual: ToolDeliveryCleanBoundary,
  expected: ToolDeliveryCleanPin): string | undefined {
  if (!actual.commit || actual.porcelain !== '' || actual.stagedDiff !== '' || actual.unstagedDiff !== '' || actual.untracked.length)
    return 'Source recorder is not globally clean.';
  if (actual.disallowedIgnoredFiles.length) return 'Unregistered ignored execution input is present.';
  if (actual.loadedBuildSha !== actual.commit || actual.configGenerationSha256 !== actual.environmentSha256)
    return 'Loaded build or config generation differs.';
  if (actual.submoduleStatus.split('\n').filter(Boolean).some(line => !line.startsWith(' ')))
    return 'Submodule checkout differs from its gitlink.';
  if (!Number.isSafeInteger(actual.pid) || actual.pid <= 0 || !/^\d+$/.test(actual.processStartTicks)
      || !/^\d+$/.test(actual.monotonicNs)) return 'Recorder process identity is unavailable.';
  if (actual.sut?.transport !== 'in-process' || actual.sut.pid !== actual.pid
      || actual.sut.processStartTicks !== actual.processStartTicks) return 'Recorder/SUT process identity differs.';
  if (!Object.keys(actual.sourceHashes).length || !Object.keys(actual.moduleHashes).length)
    return 'Source or resolved-module census is empty.';
  const { pid: _pid, processStartTicks: _start, sut: _sut, monotonicNs: _time, ...pin } = actual;
  if (digest(pin) !== digest(expected)) return 'Source, module, install, runtime or environment identity changed.';
}

export interface ToolDeliveryCleanBlock {
  scenario: string;
  arm: string;
  variantId: string;
  runIds: string[];
  before: ToolDeliveryCleanBoundary;
  after: ToolDeliveryCleanBoundary;
  requestManifestSha256: string;
}

export function toolDeliveryBlockLedgerIdentity(experimentId: string, blockIndex: number,
  block: ToolDeliveryCleanBlock): RecordedLlmBlockCustody {
  return { experimentId, blockIndex, scenarioId: block.scenario, arm: block.arm as 'compact' | 'full', variantId: block.variantId,
    beforeSha256: digest(block.before), afterSha256: digest(block.after), requestManifestSha256: block.requestManifestSha256,
    pid: block.before.pid, processStartTicks: block.before.processStartTicks, runIds: block.runIds };
}
export function validateToolDeliveryBlockLedgerIdentity(actual: unknown, experimentId: string,
  blockIndex: number, block: ToolDeliveryCleanBlock): string | undefined {
  if (digest(actual) !== digest(toolDeliveryBlockLedgerIdentity(experimentId, blockIndex, block)))
    return 'Original recorder block identity differs from the exact clean block.';
}

/** Whole-cohort failure is intentional: a changed block is never replaceable.
 * Exact run IDs also have to pass validateToolDeliveryBatchReceipt and the shared AJV
 * oracle; this guard adds provenance rather than replacing either instrument.
 */
export function validateToolDeliveryCleanBlocks(input: {
  pin: ToolDeliveryCleanPin;
  expectedBlocks: readonly { scenario: string; arm: string; variantId: string }[];
  runIds: readonly string[];
  blocks: readonly ToolDeliveryCleanBlock[];
  judgedCells: readonly { scenario: string; arm: string; judged: number; unmeasured: number }[];
}): string | undefined {
  if (input.expectedBlocks.length !== 10 || input.blocks.length !== 10 || input.runIds.length !== 30
      || new Set(input.runIds).size !== 30) return 'Incomplete or extra cohort population.';
  const ids: string[] = [];
  let previousEnd: bigint | null = null;
  let processIdentity: string | null = null;
  for (const [index, expected] of input.expectedBlocks.entries()) {
    const block = input.blocks[index]!;
    if (block.scenario !== expected.scenario || block.arm !== expected.arm || block.variantId !== expected.variantId
        || block.runIds.length !== 3) return 'Mixed experiment, order or block population.';
    for (const boundary of [block.before, block.after]) {
      if (!boundary) return 'Missing block boundary receipt.';
      const error = validateToolDeliveryCleanBoundary(boundary, input.pin);
      if (error) return error;
      const identity = `${boundary.pid}:${boundary.processStartTicks}`;
      if (processIdentity !== null && identity !== processIdentity) return 'Recorder/SUT process generation changed.';
      processIdentity = identity;
    }
    const start = BigInt(block.before.monotonicNs), end = BigInt(block.after.monotonicNs);
    if (start >= end || (previousEnd !== null && previousEnd > start)) return 'Block clocks overlap or do not advance.';
    previousEnd = end;
    if (!/^[a-f0-9]{64}$/.test(block.requestManifestSha256)) return 'Request manifest checksum is unavailable.';
    const cells = input.judgedCells.filter(cell => cell.scenario === expected.scenario && cell.arm === expected.variantId);
    if (cells.length !== 1 || cells[0]!.judged < 1 || cells[0]!.unmeasured !== 0)
      return 'Scenario/arm cell is not completely judged.';
    ids.push(...block.runIds);
  }
  if (input.judgedCells.length !== 10 || new Set(ids).size !== 30
      || digest([...ids].sort()) !== digest([...input.runIds].sort())) return 'Receipt omits or replaces attempts.';
}
