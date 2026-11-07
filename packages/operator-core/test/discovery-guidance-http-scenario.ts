/** Retained same-session discovery guidance through the real private HTTP host. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { loadHarnessRegistry } from '../lib/harness-registry';
import type { DiscoveryDeclaration } from '../lib/agent-tools/plans/plan-declarations';
import { SERVING_RUNTIMES } from '../lib/serving-runtimes';
import { probeServiceStart, readProcStartMs } from '../lib/agent-tools/dev/systemd-service-probe';
import { isLiveNodeEntrySourceCurrent, measureLiveNodeEntrySource, type LiveNodeEntrySource } from '../lib/runtime-vintage';
import { measureBootOperatorArtifact, type OperatorArtifactIdentity } from '../lib/release/operator-artifact';

/** Selection is the existing registered release service, never a caller's
 * arbitrary bundle path. A fresh private/source bundle cannot acquire this pin. */
export interface DiscoveryShippedTarget {
  runtime: 'release-operator';
  source: LiveNodeEntrySource;
  processStartedAtMs: number;
  artifact: Extract<OperatorArtifactIdentity, { status: 'measured' }>;
  health: { sha: string; service: string };
}

async function releaseHealth() {
  const runtime = SERVING_RUNTIMES['release-operator'];
  const response = await fetch(`http://127.0.0.1:${runtime.healthPort}/api/health`,
    { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200, 'selected release health must be reachable');
  const health = await response.json() as any;
  assert.equal(health.service, 'papercusp-operator');
  assert.match(health.sha, /^[a-f0-9]{7,64}$/);
  assert.equal(health.bundleStale, undefined, 'a stale fallback is not a shipped artifact');
  return { sha: health.sha as string, service: health.service as string };
}

export async function pinDiscoveryShippedTarget(): Promise<DiscoveryShippedTarget> {
  const runtime = SERVING_RUNTIMES['release-operator'];
  assert.ok(runtime.unit && runtime.codeSource === 'release-checkout');
  const service = await probeServiceStart(runtime.unit);
  assert.ok(service.ok && service.mainPid, 'registered release service needs a live process');
  const source = measureLiveNodeEntrySource(service.mainPid);
  assert.ok(source, 'release entry must be measured from the already running process');
  const processStartedAtMs = await readProcStartMs(service.mainPid);
  assert.ok(processStartedAtMs);
  const health = await releaseHealth();
  const artifact = measureBootOperatorArtifact(source.entry, health.sha, processStartedAtMs);
  assert.equal(artifact.status, 'measured', 'release needs its immutable boot artifact manifest');
  if (artifact.status !== 'measured') throw new Error('release artifact is unknown');
  assert.equal(artifact.bundleSha256, source.sha256);
  assert.ok(isLiveNodeEntrySourceCurrent(source), 'release changed during selection');
  return { runtime: 'release-operator', source, processStartedAtMs, artifact, health };
}

/** Re-resolve the service and immutable boot bytes before and after execution.
 * A replaced process, changed bundle, staging target or rewritten pin refuses. */
export async function recheckDiscoveryShippedTarget(target: DiscoveryShippedTarget) {
  assert.equal(target.runtime, 'release-operator');
  const current = await pinDiscoveryShippedTarget();
  assert.deepEqual(current, target, 'the exact shipped target changed during the journey');
  return current;
}

export async function readDiscoveryShippedTarget(argv: readonly string[]) {
  const paths = argv.filter(arg => arg.startsWith('--discovery-shipped-target='));
  const hashes = argv.filter(arg => arg.startsWith('--discovery-shipped-target-sha='));
  if (!paths.length && !hashes.length) return null;
  assert.equal(paths.length, 1); assert.equal(hashes.length, 1);
  const path = paths[0]!.slice('--discovery-shipped-target='.length);
  const sha256 = hashes[0]!.slice('--discovery-shipped-target-sha='.length);
  assert.ok(isAbsolute(path)); assert.match(sha256, /^[a-f0-9]{64}$/);
  const bytes = await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, 'shipped target receipt changed');
  const target = JSON.parse(String(bytes)) as DiscoveryShippedTarget;
  await recheckDiscoveryShippedTarget(target);
  return target;
}

type Options = { workspace: string; base: string; headers: Record<string, string>;
  evidenceDir: string; expectedSha: string };
const sourcePath = 'existing-discovery-guidance.ts';
const evidenceRef = `source:${sourcePath}`;
const questions: DiscoveryDeclaration['questions'] = [
  { id: 'Q-1', kind: 'current-behavior', question: 'What guidance already exists?',
    stopCondition: 'Read the existing guidance function.', outcome: 'unresolved' },
  { id: 'Q-2', kind: 'gap', question: 'Which caller still needs the existing guidance?',
    stopCondition: 'Compare the consumer with the requested response.', outcome: 'unresolved' },
  { id: 'Q-3', kind: 'feasibility', question: 'Can that caller reuse the function?',
    stopCondition: 'Inspect its return type and calling contract.', outcome: 'unresolved' },
];
const provisional: DiscoveryDeclaration = { questions, findings: [], notApplicable: null };
const resolved: DiscoveryDeclaration = {
  questions: questions.map(question => ({ ...question, outcome: 'answered' })), notApplicable: null,
  findings: [{ id: 'F-1', questions: questions.map(question => question.id),
    conclusion: 'The existing function provides guidance; reuse it in the missing response caller.',
    evidenceRefs: [evidenceRef], dispositions: [{ target: 'P-001', decision: 'reuse',
      reason: 'Only the response caller is missing; reuse the current function and its return contract.' }] }],
};
const discoveryBlock = (declaration: DiscoveryDeclaration) =>
  `## Discovery\n\n\`\`\`discovery\n${JSON.stringify(declaration)}\n\`\`\`\n`;
const body = '## Now\n\nResolve bounded discovery before implementation review.\n\n'
  + '## Background\n\nA response caller needs the existing guidance function.\n\n'
  + '## Phase 1\n\n- **P-001** `todo` Connect the response caller to the existing guidance function\n\n'
  + discoveryBlock(provisional);
const newArgs = { slug: 'private-discovery-guidance', title: 'Private discovery guidance journey',
  status: 'draft', content: body, force: true };

/** Validate the complete request shapes before paying for PG and a host bundle. */
export async function validateDiscoveryGuidanceRequests() {
  const [create, audit, set, get] = await Promise.all([
    import('../lib/agent-tools/plans/new'), import('../lib/agent-tools/plans/audit'),
    import('../lib/agent-tools/plans/set-content'), import('../lib/agent-tools/plans/get'),
  ]);
  create.argsSchema.parse(newArgs);
  for (const args of [{ slug: 'private-discovery-guidance', phase: 'discovery', dryRun: true },
    { slug: 'private-discovery-guidance', phase: 'activation', dryRun: true }])
    (audit.default.args as { parse(value: unknown): unknown }).parse(args);
  set.argsSchema.parse({ slug: 'private-discovery-guidance', content: body, expectedVersion: 1 });
  (get.default.args as { parse(value: unknown): unknown }).parse({
    slug: 'private-discovery-guidance', mode: 'full', includeRaw: true });
}

export async function measureDiscoveryGuidanceScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  const registry = await loadHarnessRegistry(o.workspace, { fresh: true });
  const home = registry.projects.find(project => project.slug === o.workspace);
  assert.ok(home, 'use this run\'s disposable registered repository');
  await writeFile(join(home.path, sourcePath), 'export const existingGuidance = () => "review the reconciled draft";\n',
    { flag: 'wx' });
  const callerSid = 'private-discovery-warm-' + randomUUID();
  // This caller carries the obsolete ordering into its next ordinary tool
  // interaction. Only delivered response fields replace that retained context.
  const initialGuidance = { stage: 'implementation', nextAction: 'Review the inventory task, then discover during implementation.' };
  const warmContext = { callerSid, guidance: initialGuidance };
  const transcript: Array<{ name: string; callerSid: string; status: number; result: any }> = [];
  async function invoke(name: string, args: Record<string, unknown>) {
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', {
      method: 'POST', headers: o.headers,
      body: JSON.stringify({ name, args, harness: o.workspace, callerSid, confirmed: true }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = await response.json() as any;
    await writeFile(join(o.evidenceDir, `guidance-request-${transcript.length}.json`),
      JSON.stringify({ name, args, callerSid, status: response.status, envelope }), { flag: 'wx' });
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    const text = envelope.result?.content?.find((part: any) =>
      part.type === 'text' && part.text.trim().startsWith('{'));
    const result = envelope.result?.structuredContent ?? (text ? JSON.parse(text.text) : envelope.result?.data);
    assert.ok(result, 'retain the actual structured response delivered to this caller');
    transcript.push({ name, callerSid, status: response.status, result });
    return result;
  }
  async function health() {
    const response = await fetch(o.base + '/api/health', { headers: o.headers,
      signal: AbortSignal.timeout(5_000) });
    const result = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(result.service, 'papercusp-operator');
    assert.equal(result.sha, o.expectedSha);
    assert.equal(result.bundleStale, undefined);
    return result;
  }
  const healthBefore = await health();
  const identityBefore = await invoke('coord:whoami', {});
  assert.ok(identityBefore.ownerId);
  const created = await invoke('plans:new', newArgs);
  assert.equal(created.ok, true, JSON.stringify(created));
  const slug = created.slug;
  assert.equal(typeof slug, 'string');
  const preview = await invoke('plans:audit', { slug, phase: 'discovery', dryRun: true });
  assert.equal(preview.workflow.stage, 'discovery', JSON.stringify(preview));
  assert.equal(preview.workflow.label, 'Provisional discovery brief');
  assert.equal(preview.readiness.ready, false);
  assert.equal(preview.auditSeq, undefined, 'a preview must not finalize discovery');
  assert.match(preview.workflow.nextAction, /Reconcile Discovery/);
  warmContext.guidance = preview.workflow;
  assert.notDeepEqual(warmContext.guidance, initialGuidance);
  const refused = await invoke('plans:audit', { slug, phase: 'activation', dryRun: true });
  assert.equal(refused.error, 'discovery_not_ready', JSON.stringify(refused));
  assert.match(refused.nextAction, /Reconcile Discovery/);
  // Check the proposed recovery against the running catalog, rather than a
  // source-only assertion that a future session might have the tool.
  const catalog = await invoke('tools:find', { query: '+plans:set-content', limit: 1 });
  assert.ok(catalog.hits?.some((hit: any) => hit.tool === 'plans:set-content'), JSON.stringify(catalog));
  const read = await invoke('plans:get', { slug, mode: 'full', includeRaw: true });
  const plan = read.results?.[0] ?? read;
  assert.equal(typeof plan.raw, 'string', JSON.stringify(read));
  const reconciled = plan.raw.replace(discoveryBlock(provisional), discoveryBlock(resolved));
  assert.notEqual(reconciled, plan.raw, 'incorporate findings in the exact current plan');
  const saved = await invoke('plans:set-content', { slug, expectedVersion: plan.version,
    content: reconciled, rationale: 'Incorporate the measured reuse finding before implementation review.' });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const finalized = await invoke('plans:audit', { slug, phase: 'discovery' });
  assert.equal(finalized.ok, true, JSON.stringify(finalized));
  assert.equal(finalized.readiness.ready, true, JSON.stringify(finalized));
  assert.equal(finalized.workflow.stage, 'implementation-review');
  assert.deepEqual(finalized.workflow.evidenceRefs, [evidenceRef]);
  assert.ok(Number.isInteger(finalized.auditSeq));
  assert.match(finalized.workflow.nextAction, /original intent.*full BARs/);
  assert.match(finalized.workflow.nextAction, /does not grant implementation authority/);
  // The next normal interaction in the same warm session must derive the
  // current stage again from retained server evidence, without a new brief.
  const next = await invoke('plans:audit', { slug, phase: 'discovery', dryRun: true });
  assert.equal(next.workflow.stage, 'implementation-review', JSON.stringify(next));
  assert.deepEqual(next.workflow.evidenceRefs, [evidenceRef]);
  warmContext.guidance = next.workflow;
  const identityAfter = await invoke('coord:whoami', {});
  assert.equal(identityAfter.ownerId, identityBefore.ownerId);
  const healthAfter = await health();
  const receipt = { workspace: o.workspace, slug, callerSid, actor: identityBefore.ownerId,
    actorPreserved: identityBefore.ownerId === identityAfter.ownerId,
    stages: [preview.workflow.stage, finalized.workflow.stage, next.workflow.stage],
    initialGuidance, adoptedGuidance: warmContext.guidance,
    evidenceRefs: next.workflow.evidenceRefs, refusal: refused.error,
    recoveryTool: 'plans:set-content', healthBefore, healthAfter, transcript,
    scope: 'Real private HTTP tool responses to one existing session; no model-generation claim.' };
  await writeFile(join(o.evidenceDir, 'discovery-guidance-observation.json'), JSON.stringify(receipt), { flag: 'wx' });
  return receipt;
}
