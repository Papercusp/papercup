/**
 * Live small-summary cohort for BYOC R-003. Uses the maintained, attributed MCP
 * recovery client; each sample includes process startup and complete response parsing.
 * This measures summary reads only, not stalled-write isolation or deployed acceptance.
 *
 * PAPERCUSP_SID and PAPERCUSP_WORKSPACE must identify the calling session.
 * Usage: npx tsx scripts/bench-work-items-get.ts --port=3170 --ids=WI-1,WI-2
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry';
import { collectPerfWorkloadRun, type PerfWorkloadManifest, type PerfWorkloadRunDependencies, type PerfWorkloadRunPlan } from '../packages/operator-core/lib/system-health/perf-workload-run';
import { perfProtocolHash } from '../packages/operator-core/lib/system-health/perf-workload-protocol';
import { AgentMcpConnectionError, connectAgentMcp } from '../packages/operator-core/lib/agent-mcp-client';
import { buildMcpCallParams, buildMcpSessionQuery, resolveMcpCallOrigin, resolveMcpRole, superuserTokenPaths } from './mcp-call.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let execMemo: typeof execFile.__promisify__ | null = null;
const exec = ((...args: unknown[]) =>
  Reflect.apply((execMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
const SOURCE_PATHS = [
  'packages/operator-core/lib/agent-tools/work_items/get.ts',
  'packages/operator-core/lib/agent-tools/work_items/get-shape.ts',
  'scripts/mcp-call.mjs',
  'scripts/bench-work-items-get.ts',
  'packages/operator-core/lib/agent-mcp-client.ts',
  'packages/operator-core/lib/system-health/perf-workload-run.ts',
  'packages/operator-core/lib/system-health/perf-workload-protocol.ts',
] as const;
const PICK = ['ok', 'results[].id', 'results[].availability', 'results[].ok',
  'results[].workItem.id', 'results[].workItem.state', 'counts', 'read'];

export interface Sample {
  size: number;
  repeat: number;
  wallMs: number;
  valid: boolean;
  failures: string[];
  read: unknown;
}

export function validateSummary(result: any, ids: string[]): string[] {
  const failures: string[] = [];
  const rows = Array.isArray(result?.results) ? result.results : [];
  if (result?.ok !== true || result?.counts?.ok !== ids.length || result?.counts?.failed !== 0) {
    failures.push('successful authoritative counts missing');
  }
  if (rows.length !== ids.length || new Set(rows.map((row: any) => row.id)).size !== ids.length) {
    failures.push('requested row census differs');
  }
  for (const id of ids) {
    const row = rows.find((entry: any) => entry.id === id);
    if (row?.ok !== true || row?.availability !== 'available' || row?.workItem?.id !== id ||
        typeof row?.workItem?.state !== 'string' || !row.workItem.state) {
      failures.push(`missing or unavailable identity/state: ${id}`);
    }
  }
  const read = result?.read;
  if (read?.schemaVersion !== 'work-items-get-read-v1' || read?.mode !== 'projected' ||
      read?.requested !== ids.length || read?.available !== ids.length || read?.absent !== 0 ||
      read?.unavailable !== 0 || typeof read?.elapsedMs !== 'number' ||
      !Number.isFinite(read.elapsedMs) || read.elapsedMs < 0 || !read?.outerStageAttribution) {
    failures.push('top-level availability/timing disclosure missing');
  }
  return failures;
}

export function judgeSamples(samples: Sample[], sizes: number, repeats: number, limitMs = 2_000) {
  const complete = samples.length === sizes * repeats && Array.from({ length: sizes }, (_, i) => i + 1)
    .every(size => Array.from({ length: repeats }, (_, repeat) => repeat + 1)
      .every(repeat => samples.filter(sample => sample.size === size && sample.repeat === repeat).length === 1));
  const timings = samples.map(sample => sample.wallMs).sort((a, b) => a - b);
  const timingValid = timings.every(value => Number.isFinite(value) && value >= 0);
  const p95Ms = timings.length && timingValid ? timings[Math.ceil(timings.length * .95) - 1]! : null;
  return { complete, p95Ms, limitMs, passed: complete && timingValid && p95Ms !== null &&
    p95Ms <= limitMs && samples.every(sample => sample.valid && sample.failures.length === 0) };
}

function sourceHashes() {
  return Object.fromEntries(SOURCE_PATHS.map(path =>
    [path, createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex')]));
}

export async function runSummaryCohort(input: {
  ids: string[];
  repeats: number;
  call: (ids: string[]) => Promise<unknown>;
  now?: () => number;
}) {
  if (!input.ids.length || input.ids.length > 10 || new Set(input.ids).size !== input.ids.length ||
      !Number.isInteger(input.repeats) || input.repeats < 1 || input.repeats > 10) {
    throw new Error('Use 1–10 distinct item ids and 1–10 repeats');
  }
  const now = input.now ?? (() => performance.now());
  const samples: Sample[] = [];
  for (let repeat = 1; repeat <= input.repeats; repeat += 1) {
    for (let size = 1; size <= input.ids.length; size += 1) {
      const ids = input.ids.slice(0, size);
      const start = now();
      let result: any;
      let failures: string[];
      try {
        result = await input.call(ids);
        failures = validateSummary(result, ids);
      } catch {
        // Child errors can contain token paths or payloads: preserve the failed
        // sample without copying opaque transport diagnostics into the artifact.
        failures = ['MCP client failed; no successful authoritative response'];
      }
      samples.push({ size, repeat, wallMs: now() - start, valid: failures.length === 0,
        failures, read: result?.read ?? null });
    }
  }
  return { samples, verdict: judgeSamples(samples, input.ids.length, input.repeats) };
}

/** Independent identity oracle, read through coord:whoami before the trial. */
export interface McpIdentityFixture {
  ownerId: string; ownerLabel: string; source: string; workspaceId: string;
  userId: string | null; fleetSlug: string | null; fleetRole: string | null; inbox_wake_key: string;
}

/** Exact finite SSE fixture; this exercises identity routing, not SC-001 as a whole. */
export function mcpIdentityFixture(identity: McpIdentityFixture, query: string) {
  if (!identity.ownerId || !identity.workspaceId || !identity.ownerLabel || !identity.source ||
      identity.inbox_wake_key !== `coord:inbox-wake:${identity.ownerId}` ||
      [identity.userId, identity.fleetSlug, identity.fleetRole].some(value => value !== null && typeof value !== 'string')) throw new Error('verified identity fixture required');
  const parameters = new URLSearchParams(query);
  if (parameters.get('client') !== identity.ownerId || parameters.get('workspace') !== identity.workspaceId ||
      parameters.get('superuser') !== '1' || parameters.get('format') !== 'json') throw new Error('fixture attribution differs');
  const expected = { ownerId: identity.ownerId, ownerLabel: identity.ownerLabel, source: identity.source,
    workspaceId: identity.workspaceId, userId: identity.userId, fleetSlug: identity.fleetSlug,
    fleetRole: identity.fleetRole, inbox_wake_key: identity.inbox_wake_key };
  const expectedBody = ':stream-open\n\nevent: message\ndata: ' + JSON.stringify({
    result: { content: [{ type: 'text', text: JSON.stringify(expected) }] }, jsonrpc: '2.0', id: 1,
  }) + '\n\n';
  return { identity: expected, expectedBody, request: {
    id: 'identity', path: `/api/mcp?${parameters}`, method: 'POST' as const,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: buildMcpCallParams('coord:whoami', {}, { outputGroupId: randomUUID() }) }),
    contentType: 'application/json' as const, accept: 'application/json, text/event-stream' as const,
    atMs: 0, timeoutMs: 10_000, maximumResponseBytes: 64_000, expectedStatus: 200,
    expectedContentType: 'text/event-stream', expectedBodySha256: createHash('sha256').update(expectedBody).digest('hex'),
  } };
}

export interface IdentityWarmupClient {
  callTool(params: { name: string; arguments: Record<string, unknown>; _meta?: { outputGroupId: string } }): Promise<unknown>;
  close(): Promise<void>;
}

/** Allowlisted evidence only: transport errors may contain credentials or URLs. */
export function identityFailure(error: unknown): Record<string, unknown> {
  if (error instanceof AgentMcpConnectionError) return { code: error.message, connection: error.diagnostic };
  const known = ['warmup-tool-error', 'warmup-content-shape', 'warmup attribution differs',
    'staging health unavailable', 'loaded build identity unavailable', 'staging process identity unavailable',
    'unified staging cgroup unavailable', 'invalid staging census', 'invalid process start identity',
    'process changed during snapshot', 'staging census changed during snapshot'];
  const message = error instanceof Error ? error.message : '';
  if (known.includes(message)) return { code: message };
  if (error instanceof SyntaxError) return { code: 'invalid-json' };
  const code = (error as { code?: unknown } | null)?.code;
  return { code: 'unclassified-failure', ...(typeof code === 'number' && Number.isSafeInteger(code) ? { mcpCode: code } : {}) };
}

export class IdentityPreparationError extends Error {
  constructor(readonly failures: Array<{ stage: 'connect' | 'call' | 'validate' | 'close'; diagnostic: Record<string, unknown> }>) {
    super('identity-preparation-failed');
  }
}

/** A failed later snapshot must never erase the primary preparation evidence. */
export async function identitySnapshot(capture: () => Promise<PerfWorkloadManifest>) {
  try {
    const manifest = structuredClone(await capture());
    return { manifest, hash: perfProtocolHash(manifest), failure: null };
  } catch (error) { return { manifest: null, hash: null, failure: identityFailure(error) }; }
}

export async function identityPreparationProbe(capture: () => Promise<PerfWorkloadManifest>,
  prepare: () => Promise<Record<string, unknown>>) {
  const initial = await identitySnapshot(capture);
  let preparation: Record<string, unknown> | null = null;
  let failures: IdentityPreparationError['failures'] = [];
  try { preparation = await prepare(); }
  catch (error) { failures = error instanceof IdentityPreparationError ? error.failures : [{ stage: 'call', diagnostic: identityFailure(error) }]; }
  const final = await identitySnapshot(capture);
  return { initial, preparation, failures, final,
    manifestStable: initial.hash !== null && final.hash !== null && initial.hash === final.hash };
}

/** Observed SDK warmup, with cold application reset explicitly unqualified. */
export function identityPreparation(fixture: ReturnType<typeof mcpIdentityFixture>, connect: () => Promise<IdentityWarmupClient>): PerfWorkloadRunDependencies['prepare'] {
  const expected = perfProtocolHash(fixture.identity);
  return async context => {
    if (context.stratum === 'cold' || context.requestId !== null) throw new Error('application cold reset is not qualified');
    const startedAtMs = Date.now();
    let client: IdentityWarmupClient;
    try { client = await connect(); }
    catch (error) { throw new IdentityPreparationError([{ stage: 'connect', diagnostic: identityFailure(error) }]); }
    const observations: Array<{ responseHash: string; matched: boolean }> = [];
    const failures: IdentityPreparationError['failures'] = [];
    let stage: 'call' | 'validate' = 'call';
    try {
      for (let i = 0; i < 3; i++) {
        stage = 'call';
        const value = await client.callTool({ name: 'coord:whoami', arguments: {}, _meta: { outputGroupId: randomUUID() } }) as {
          isError?: boolean; content?: Array<{ type: string; text?: string }>;
        };
        stage = 'validate';
        if (value?.isError) throw new Error('warmup-tool-error');
        if (value?.content?.length !== 1 || value.content[0].type !== 'text' ||
            typeof value.content[0].text !== 'string') throw new Error('warmup-content-shape');
        const responseHash = perfProtocolHash(JSON.parse(value.content[0].text));
        if (responseHash !== expected) throw new Error('warmup attribution differs');
        observations.push({ responseHash, matched: true });
      }
    } catch (error) { failures.push({ stage, diagnostic: identityFailure(error) }); }
    try { await client.close(); }
    catch (error) { failures.push({ stage: 'close', diagnostic: identityFailure(error) }); }
    if (failures.length) throw new IdentityPreparationError(failures);
    return { method: 'maintained-agent-mcp-http-identity-warmup-v1', ...context, startedAtMs, endedAtMs: Date.now(),
      observations, applicationColdResetQualified: false,
      transport: 'separate-sdk-warmup-session;measurement-stateless-http' };
  };
}

/** Real process census and loaded health identity; never retain raw credentials/environment. */
export async function captureIdentityEnvironment(fixture: ReturnType<typeof mcpIdentityFixture>): Promise<PerfWorkloadManifest> {
  const response = await fetch('http://127.0.0.1:3170/api/health', { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error('staging health unavailable');
  const health = await response.json() as Record<string, unknown>;
  if (health.ok !== true || health.service !== 'papercusp-operator' || typeof health.sha !== 'string' ||
      !/^[a-f0-9]{7,40}$/.test(health.sha) || health.bundleStale) throw new Error('loaded build identity unavailable');
  // The health writer documents ts as observation time, not loaded configuration.
  const { ts: _observationTime, ...loadedHealth } = health;
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const main = await exec('systemctl', ['--user', 'show', 'papercup-staging-api.service', '--property=MainPID', '--value'],
    { timeout: 10_000, maxBuffer: 16_384 });
  const mainPid = Number(main.stdout.trim());
  if (!Number.isSafeInteger(mainPid) || mainPid < 1) throw new Error('staging process identity unavailable');
  const cgroup = /^0::(\/[^\n]*)$/m.exec(await readFile(`/proc/${mainPid}/cgroup`, 'utf8'))?.[1];
  if (!cgroup || cgroup.split('/').includes('..')) throw new Error('unified staging cgroup unavailable');
  const census = async () => (await readFile(`/sys/fs/cgroup${cgroup}/cgroup.procs`, 'utf8')).trim().split(/\s+/).map(Number).sort((a, b) => a - b);
  const pids = await census();
  if (!pids.includes(mainPid) || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw new Error('invalid staging census');
  const processes = await Promise.all(pids.map(async pid => {
    const stat = () => readFile(`/proc/${pid}/stat`, 'utf8');
    const start = (value: string) => value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const before = start(await stat());
    if (!before || !/^[0-9]+$/.test(before)) throw new Error('invalid process start identity');
    const environmentHash = createHash('sha256').update(await readFile(`/proc/${pid}/environ`)).digest('hex');
    const cwd = await realpath(`/proc/${pid}/cwd`);
    const executable = await realpath(`/proc/${pid}/exe`);
    if (before !== start(await stat())) throw new Error('process changed during snapshot');
    return { pid, startTicks: before, environmentHash, cwd, executable };
  }));
  if (JSON.stringify(pids) !== JSON.stringify(await census())) throw new Error('staging census changed during snapshot');
  return {
    source: { loadedBuild: loadedHealth, collectorFiles: sourceHashes() },
    configuration: { port: 3170, processEnvironments: processes.map(({ pid, startTicks, environmentHash }) => ({ pid, startTicks, environmentHash })),
      opaqueReasons: ['dynamic-runtime-configuration-and-dependency-closure-not-yet-qualified'] },
    runtime: { mainPid, cgroup, processes: processes.map(({ environmentHash: _environmentHash, ...identity }) => identity) },
    host: { bootId, platform: process.platform, architecture: process.arch },
    workload: { journey: 'attributed-mcp-identity-only', transport: 'stateless-http-finite-sse', coldResetQualified: false,
      notCovered: ['representative-api-mcp-mix', 'long-lived-stream-continuity', 'database', 'compiler', 'gpu', 'vm'] },
    fixture: { identity: fixture.identity, request: fixture.request, expectedBody: fixture.expectedBody },
  };
}

async function runMatchedIdentity(flags: Record<string, string>) {
  if (!flags['identity-file'] || flags.port && flags.port !== '3170') throw new Error('matched identity requires --identity-file and staging port 3170');
  const stage = flags.stage ?? 'collect';
  if (!['manifest', 'preparation', 'collect'].includes(stage)) throw new Error('unknown identity stage');
  const identity = JSON.parse(await readFile(resolve(flags['identity-file']), 'utf8')) as McpIdentityFixture;
  if (identity.ownerId !== process.env.PAPERCUSP_SID || identity.workspaceId !== process.env.PAPERCUSP_WORKSPACE) throw new Error('fixture does not belong to this session');
  const query = buildMcpSessionQuery({ client: identity.ownerId, workspace: identity.workspaceId, harness: 'papercusp',
    role: resolveMcpRole(), origin: resolveMcpCallOrigin(identity.ownerId) });
  const fixture = mcpIdentityFixture(identity, query.toString());
  const tokens = superuserTokenPaths().flatMap(path => { try { return path ? [readFileSync(path, 'utf8').trim()].filter(Boolean) : []; } catch { return []; } });
  if (!tokens.length) throw new Error('runtime credential unavailable');
  const headers = { authorization: `Bearer ${tokens[0]}` };
  const prepare = identityPreparation(fixture, async () => (await connectAgentMcp({
    url: `http://127.0.0.1:3170${fixture.request.path}`, headers, mode: 'http', timeoutMs: 10_000,
    name: 'host-memory-p001-identity-preparation',
  })).client);
  const count = Number(flags.count ?? 1);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error('count must be 1–10000');
  const capture = () => captureIdentityEnvironment(fixture);
  if (stage === 'preparation') {
    const probe = await identityPreparationProbe(capture, () => prepare({ arm: 'a', journey: 'attributed-mcp-identity-only', stratum: 'warm', requestId: null }));
    process.stdout.write(`${JSON.stringify({ kind: 'unqualified-identity-preparation', acceptance: 'unknown', probe }, null, 2)}\n`);
    if (!probe.preparation || !probe.manifestStable) process.exitCode = 1;
    return;
  }
  const initial = await identitySnapshot(capture);
  if (stage === 'manifest' || !initial.manifest) {
    const final = stage === 'manifest' ? await identitySnapshot(capture) : null;
    const manifestStable = initial.hash !== null && final?.hash === initial.hash;
    process.stdout.write(`${JSON.stringify({ kind: 'unqualified-identity-manifest', acceptance: 'unknown', initial, final, manifestStable }, null, 2)}\n`);
    if (!manifestStable) process.exitCode = 1;
    return;
  }
  const manifest = initial.manifest;
  const preparationFailures: Array<{ arm: string; stratum: string; failures: IdentityPreparationError['failures'] }> = [];
  const manifestFailures: Array<{ arm: string; diagnostic: Record<string, unknown> }> = [];
  const plan: PerfWorkloadRunPlan = { independentRepeatId: flags['repeat-id'] ?? `identity-smoke-${Date.now()}`,
    phase: 'baseline', origins: { a: 'http://127.0.0.1:3170', b: 'http://127.0.0.1:3170' },
    expectedManifestHashes: { a: perfProtocolHash(manifest), b: perfProtocolHash(manifest) },
    groups: (['warm', 'burst'] as const).map(stratum => ({ journey: 'attributed-mcp-identity-only', stratum,
      armOrder: ['a', 'b'], concurrency: stratum === 'burst' ? 4 : 1, exposureMs: count * 15_000 + 1_000,
      maximumStartLatenessMs: 1_000, requests: Array.from({ length: count }, (_, index) => ({ ...fixture.request,
        id: `identity-${index}`, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: buildMcpCallParams('coord:whoami', {}, { outputGroupId: randomUUID() }) }),
        atMs: stratum === 'burst' ? Math.floor(index / 4) * 15_000 : index * 15_000 })) })) };
  const run = await collectPerfWorkloadRun(plan, { transportHeaders: { a: headers, b: headers }, prepare: async context => {
    try { return await prepare(context); } catch (error) {
      preparationFailures.push({ arm: context.arm, stratum: context.stratum,
        failures: error instanceof IdentityPreparationError ? error.failures : [{ stage: 'call', diagnostic: identityFailure(error) }] });
      throw error;
    }
  },
    captureManifest: async arm => {
      try { return await capture(); }
      catch (error) { manifestFailures.push({ arm, diagnostic: identityFailure(error) }); throw error; }
    } });
  process.stdout.write(`${JSON.stringify({ kind: 'unqualified-identity-workload-smoke', acceptance: 'unknown',
    reason: 'identity-only;no-application-cold-reset;no-independent-repeat-or-complete-runtime-closure', initial, preparationFailures, manifestFailures, run }, null, 2)}\n`);
  if (run.status !== 'collected' || run.groups.some(group => group.arms.some(arm => arm.requests.some(row => row.outcome !== 'success')))) process.exitCode = 1;
}

async function main() {
  const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--(ids|port|repeats|mode|stage|identity-file|count|repeat-id)=(.+)$/.exec(arg);
    if (!match) throw new Error('Unknown benchmark flag');
    return [match[1], match[2]];
  }));
  const client = process.env.PAPERCUSP_SID;
  const workspace = process.env.PAPERCUSP_WORKSPACE;
  if (!client || !workspace) throw new Error('Verified session identity and workspace are required');
  if (flags.mode === 'matched-identity') return runMatchedIdentity(flags);
  if (flags.mode) throw new Error('Unknown benchmark mode');
  const ids = (flags.ids ?? '').split(',').filter(Boolean);
  const port = flags.port ?? '3170';
  if (port !== '3170') throw new Error('This pre-release probe is pinned to the staging operator on 3170');
  const repeats = Number(flags.repeats ?? 4);
  const startedAt = new Date().toISOString();
  const before = sourceHashes();
  const result = await runSummaryCohort({ ids, repeats, call: async requested => {
    const args = { ids: requested, harness: 'papercusp', detail: false, threadLimit: 0,
      projection: { pick: PICK } };
    const child = await exec(process.execPath, [resolve(ROOT, 'scripts/mcp-call.mjs'), 'work_items:get',
      JSON.stringify(args), '--client', client, '--workspace', workspace, '--harness', 'papercusp',
      '--port', port], { cwd: ROOT, timeout: 35_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(child.stdout);
  } });
  const after = sourceHashes();
  const sourceStable = JSON.stringify(before) === JSON.stringify(after);
  const report = { schemaVersion: 1, kind: 'operational-test-evidence',
    name: 'BYOC P009 R003 current-build summary cohort', startedAt, finishedAt: new Date().toISOString(),
    endpoint: 'http://127.0.0.1:3170/api/mcp', client, workspace, ids, repeats,
    method: 'maintained mcp-call subprocess wall clock, including startup and response parsing; unique output group per call',
    sourceHashes: before, sourceStable, ...result,
    passed: sourceStable && result.verdict.passed,
    notExercised: ['stalled unrelated checkpoint/claim write', 'same-item ordering/conflict',
      'cancellation/drain', 'forwarding outcome ambiguity', 'deployed R006 acceptance'] };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) void main().catch(() => {
  console.error('Summary probe failed before a complete report; inspect the maintained command inputs');
  process.exitCode = 1;
});
