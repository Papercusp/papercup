import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { canonicalJson } from '@papercusp/hash-chain';
import type { ExternalBlockerRecord } from './external-blockers';
import { readExternalBlockers } from './external-blockers';
import type { BlockerEvidenceMeasurement } from './blocker-resolution-decision';

const relativePath = z.string().min(1).max(1000).refine(path =>
  !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..'),
  'Expected a repository-relative source path');
export const runtimeConditionBindingInputSchema = z.object({
  schemaVersion: z.literal(1),
  host: z.string().regex(/^port-[1-9][0-9]{0,4}$/),
  sourceBlobs: z.record(relativePath, z.string().regex(/^[a-f0-9]{40}$/))
    .refine(blobs => Object.keys(blobs).length > 0 && Object.keys(blobs).length <= 32, 'Supply 1–32 exact source blobs'),
  toolSchema: z.object({ tool: z.string().trim().min(1).max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  reason: z.string().trim().min(1).max(2000),
  reasonRef: z.string().trim().min(1).max(1000),
}).strict();
export type RuntimeConditionBindingInput = z.infer<typeof runtimeConditionBindingInputSchema>;
const storedBindingSchema = runtimeConditionBindingInputSchema.extend({
  boundBy: z.string().min(1), boundAt: z.string().datetime({ offset: true }),
}).strict();
export type RuntimeConditionBinding = z.infer<typeof storedBindingSchema>;

/** Metadata compatibility only: the custodian declares what the old alias meant.
 * This does not measure recovery, change the original ref/status, or release custody.
 * The writer fences custody and the original blocker array in the same payload CAS. */
export function prepareRuntimeBlockerBinding(
  item: { state: string; assignee: string | null; payload: unknown },
  ref: string, input: unknown, actor: string, now = new Date().toISOString(),
): { ok: true; changed: boolean; blockers: ExternalBlockerRecord[] } | { ok: false; code: string; error: string } {
  const refuse = (error: string) => ({ ok: false as const, code: 'runtime_binding_invalid', error });
  if (item.assignee !== actor || !actor ||
      ['done', 'resolved', 'closed', 'passed', 'dropped', 'deprecated', 'failed', 'cancelled'].includes(item.state)) {
    return refuse('Only the current custodian of a non-terminal item may bind its runtime condition.');
  }
  const parsed = runtimeConditionBindingInputSchema.safeParse(input);
  if (!parsed.success) return refuse('Supply a strict runtime source/schema binding with reason and reasonRef.');
  const blockers = readExternalBlockers(item.payload);
  const matches = blockers.map((row, index) => ({ row, index }))
    .filter(({ row }) => row.ref === ref && row.status === 'active');
  if (matches.length !== 1 || matches[0].row.kind !== 'runtime') return refuse('Name exactly one active runtime blocker.');
  const { row, index } = matches[0];
  if (row.runtimeConditionBinding !== undefined) {
    const stored = storedBindingSchema.safeParse(row.runtimeConditionBinding);
    if (!stored.success) return refuse('Stored runtime binding is unreadable; do not overwrite it.');
    const { boundBy: _actor, boundAt: _time, ...prior } = stored.data;
    return isDeepStrictEqual(prior, parsed.data) ? { ok: true, changed: false, blockers }
      : refuse('A runtime condition is already bound; replacing it requires a separate reviewed transition.');
  }
  blockers[index] = { ...row, runtimeConditionBinding: { ...parsed.data, boundBy: actor, boundAt: now } };
  return { ok: true, changed: true, blockers };
}

/** Fingerprint the actual loaded public argument schema, never a checkout file. */
export async function readRuntimeToolSchemaIdentity(toolName: string) {
  const { listAllProjectedTools } = await import('@papercusp/tooldef');
  const tool = listAllProjectedTools().find(entry => entry.expose.mcp?.name === toolName);
  if (!tool?.inputSchema) return null;
  return { tool: toolName, sha256: createHash('sha256').update(canonicalJson(tool.inputSchema)).digest('hex') };
}

export async function readRuntimeBlockerCondition(blocker: { kind: string; ref: string; runtimeConditionBinding?: unknown }):
Promise<BlockerEvidenceMeasurement> {
  const unknown = (detail: string): BlockerEvidenceMeasurement => ({ status: 'unknown', detail });
  if (blocker.kind !== 'runtime') return unknown('canonical runtime blocker is required');
  const parsed = storedBindingSchema.safeParse(blocker.runtimeConditionBinding);
  if (!parsed.success) return unknown('runtime alias needs an audited source/schema binding before resolution');
  const binding = parsed.data;
  try {
    const [{ getServingHostIdentity }, { runtimeObservabilityHealth }] = await Promise.all([
      import('./serving-host-identity'), import('./observability/runtime'),
    ]);
    const host = getServingHostIdentity();
    const artifact = runtimeObservabilityHealth().artifact;
    if (host.host !== binding.host || !host.processId || !host.buildSha || artifact?.status !== 'measured' ||
        !artifact.sourceSha.startsWith(host.buildSha) || !/^[a-f0-9]{64}$/.test(artifact.bundleSha256) ||
        !/^[a-f0-9]{64}$/.test(artifact.manifestSha256)) return unknown('named serving process has no bound boot artifact measurement');
    const schema = await readRuntimeToolSchemaIdentity(binding.toolSchema.tool);
    if (!schema) return unknown('loaded public tool schema is unavailable');
    const paths = Object.keys(binding.sourceBlobs);
    if (paths.some(path => !artifact.sourceBlobs[path])) return unknown('boot artifact omits required source containment');
    const satisfied = paths.every(path => artifact.sourceBlobs[path] === binding.sourceBlobs[path]) &&
      schema.sha256 === binding.toolSchema.sha256;
    return { status: 'available', condition: satisfied ? 'satisfied' : 'pending', reachable: true,
      responsibleParty: `runtime:${binding.host}` };
  } catch { return unknown('runtime artifact/schema evidence reader failed'); }
}
