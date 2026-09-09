import { readFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { installFlagOverrideStore } from '../../packages/operator-core/lib/flag-override-store.ts';
import { productionDreamCycle } from '../../packages/operator-core/lib/dream/dream-cycle-action.ts';
import { dreamEvaluationProtocolHash, DreamPilotPinSchema } from '../../packages/operator-core/lib/dream/dream-evaluation.ts';
import { rerankCapabilityPriors } from '../../packages/operator-core/lib/dream/capability-review.ts';
import { getPilotCapabilityManifest } from '../../packages/operator-core/lib/dream/capability-catalog.ts';
import { buildCapabilityPacket } from '../../packages/operator-core/lib/dream/capability-packets.ts';
import { buildCapabilitySamplingSnapshot, sampleCapabilityCombination } from '../../packages/operator-core/lib/dream/capability-sampler.ts';
import { CAPABILITY_DREAM_PROMPT_VERSION } from '../../packages/operator-core/lib/dream/capability-pass.ts';
import { studySampling } from './sampling.mts';

// This standalone driver does not inherit the operator service's environment.
// A fresh in-process model can miss the review deadline after generation is paid.
// Require the operator's configured local sidecar and prove readiness before any write.
const sidecar = process.env.PAPERCUSP_EMBED_SIDECAR_URL;
if (!sidecar || !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/?$/.test(sidecar))
  throw new Error('D017 study requires PAPERCUSP_EMBED_SIDECAR_URL from the local operator service before any settings change or paid call');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const workspaceId = 'papercusp-workspace';
process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
const frozen = JSON.parse(await readFile(resolve(here, 'protocol.json'), 'utf8'));
if (dreamEvaluationProtocolHash(frozen.protocol) !== frozen.pin) throw new Error('Study protocol hash changed');
const arm = process.argv.find(arg => ['uniform-pair', 'structured-pair', 'structured-triple'].includes(arg)) ?? 'uniform-pair';
const pilot = DreamPilotPinSchema.parse({ ...frozen, arm });
const log = async (entry: unknown) => {
  const line = JSON.stringify({ at: new Date().toISOString(), entry });
  await appendFile(resolve(here, 'cycle-events.jsonl'), line + '\n');
  console.log(line);
};
async function tool(name: string, args: object) {
  const raw = await new Promise<string>((done, fail) => {
    const child = spawn('ptool', [name, '--url=http://127.0.0.1:3170', '--workspace=' + workspaceId, '--harness=papercusp', '--json', '-'], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', code => code === 0 ? done(stdout) : fail(new Error(name + ' exit ' + code + ': ' + stderr.slice(-1000))));
    child.stdin.end(JSON.stringify(args));
  });
  let result = JSON.parse(raw);
  if (Array.isArray(result.content)) {
    const text = result.content.find((c: { type: string; text?: string }) => c.type === 'text' && c.text?.trim().startsWith('{'));
    if (text) result = JSON.parse(text.text);
  }
  await log({ tool: name, result });
  if (result.ok !== true || result.applied === false || result.reverted === true) throw new Error(name + ' did not confirm success');
  return result;
}
installFlagOverrideStore();
const { sql } = getOrgPg();
const master = await sql<Array<{ enabled: boolean }>>`
  SELECT enabled FROM harness_shared.learning_pot_scope
  WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'`;
if (master.length !== 1 || master[0]!.enabled !== false) throw new Error('Expected disabled master; inspect current owner state before this temporary restore protocol');
const totals = await sql<Array<{ arm: string; attempts: number; cost: number }>>`
  SELECT outcome->'capabilityRun'->'evaluation'->>'arm' AS arm,
         COUNT(*)::int AS attempts, SUM(cost_usd)::float8 AS cost
    FROM harness_shared.dream_runs
   WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'
     AND outcome->'capabilityRun'->'evaluation'->>'protocolPin' = ${frozen.pin}
   GROUP BY 1`;
const used = totals.find(row => row.arm === arm);
if ((used?.attempts ?? 0) >= frozen.protocol.limits.attemptsPerArm ||
    (used?.cost ?? 0) + frozen.protocol.limits.cycleUsd > frozen.protocol.limits.discoveryUsdPerArm)
  throw new Error('Arm attempt or conservative monetary admission cap reached');
// Replay the actual bounded source set from the failed review, without repeating
// its generation or changing the study record. Keep original failures in the funnel.
const [readiness] = await sql<Array<{ review: any; outcome: any }>>`
  SELECT review, outcome FROM harness_shared.dream_runs
   WHERE workspace_id = ${workspaceId}
     AND run_id = 'dream-cycle:papercusp-workspace:papercusp:edd8d09c-5088-4ed8-b567-7bb6a3b917bf:dream:1'`;
if (!readiness?.review?.priorMatches?.length || !readiness?.outcome?.insight?.capability)
  throw new Error('D017 rerank readiness evidence is missing');
const candidate = readiness.outcome.insight.capability;
const ranked = await rerankCapabilityPriors(candidate.behavior + '\n' + candidate.priorArt.proposedDelta, readiness.review.priorMatches);
await log({ phase: 'rerank-readiness', outcome: ranked.outcome, expected: readiness.review.priorMatches.length });
if (!ranked.outcome.attempted || ranked.outcome.scored !== readiness.review.priorMatches.length) {
  await sql.end();
  throw new Error('D017 reranker is not ready; no settings changed and no provider called');
}
const manifest = getPilotCapabilityManifest();
const packetScope = { workspaceId, potSlug: 'papercusp', repositoryId: 'papercusp' };
const packets = [];
for (const unit of manifest.units) {
  const built = await buildCapabilityPacket({ rootPath: root, scope: packetScope, unit, manifestRevision: manifest.revision });
  if (built.status !== 'ready') throw new Error('Study packet unavailable: ' + unit.id);
  packets.push(built.packet);
}
const snapshot = await buildCapabilitySamplingSnapshot({ rootPath: root, scope: packetScope, manifest, packets });
if (snapshot.fingerprint !== frozen.protocol.sourceSnapshot) throw new Error('Frozen study source snapshot changed');
const { sampler, annotationHash } = studySampling(snapshot, arm);
const sample = sampleCapabilityCombination(snapshot, { ...sampler, seed: frozen.protocol.seed + ':readiness', now: Date.now(), promptVersion: CAPABILITY_DREAM_PROMPT_VERSION });
if (sample.status !== 'selected' || (arm === 'structured-triple' && !sample.selection.c))
  throw new Error('Study sampler cannot supply its declared arm; no settings changed and no provider called');
await log({ phase: 'sampling-readiness', arm, annotationHash, sampler, sourceSnapshot: snapshot.fingerprint });
await log({ phase: 'prepared', arm, protocolPin: frozen.pin, masterEnabled: false, priorStudyArms: totals });
if (!process.argv.includes('--run')) {
  await log({ phase: 'dry-run', message: 'No settings changed and no provider called. Pass --run for one governed attempt.' });
  await sql.end();
  process.exit(0);
}
let routineAudit: string | undefined;
let masterAttempted = false;
try {
  const routine = await tool('routines:set', {
    name: 'dream-cycle-manual', installSlug: 'papercusp',
    cron: '0 0 0 1 1 *', active: true,
    payloadTemplate: {
      mode: 'manual', pilot,
      cycle: { maxDreamsPerCycle: 1, maxCostUsd: frozen.protocol.limits.cycleUsd, rolling24hCostUsd: frozen.protocol.limits.rollingDayUsd },
      sampler,
      pass: { model: frozen.protocol.models.generator }, review: { model: frozen.protocol.models.reviewer },
    },
  });
  routineAudit = routine.revertHandle?.args?.auditId ?? routine.auditId;
  if (!routineAudit) throw new Error('No durable routine revert handle; inspect mutation outcome before any spend');
  masterAttempted = true;
  await tool('learning:set-pot-scope', { pots: ['papercusp'], enabled: true });
  const result = await productionDreamCycle({ workspaceId, installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null }, {
    mode: 'manual', pilot,
    cycle: { maxDreamsPerCycle: 1, maxCostUsd: frozen.protocol.limits.cycleUsd, rolling24hCostUsd: frozen.protocol.limits.rollingDayUsd },
    sampler,
    pass: { model: frozen.protocol.models.generator }, review: { model: frozen.protocol.models.reviewer },
  });
  await log({ phase: 'cycle-result', arm, protocolPin: frozen.pin, result });
} finally {
  const cleanupErrors: unknown[] = [];
  if (masterAttempted) {
    try { await tool('learning:set-pot-scope', { pots: ['papercusp'], enabled: false }); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (routineAudit) {
    try { await tool('routines:revert', { auditId: routineAudit }); }
    catch (error) { cleanupErrors.push(error); }
  }
  await log({ phase: 'restoration', success: cleanupErrors.length === 0, errors: cleanupErrors.map(String) });
  await sql.end();
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Study restoration needs immediate attention');
}
process.exit(0);
