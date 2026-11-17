/**
 * Frozen pre-implementation baseline for identity-definitions-own-policy-2026-10-17 P-001.
 *
 * The tool schemas come from a real launched Codex home's managed tool prompts, not
 * from the capability-envelope implementation this plan changes. The population is
 * derived independently from the built-in blueprint documents. Runtime observations
 * are immutable ledger receipts collected on 2026-10-22.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { chain, none } from 'stream-chain';
import fun from 'stream-chain/fun.js';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { isCliEntry } from '../util/cli-entry';
import { moduleRepoRoot } from '../module-repo-root';
import { parse as parseYaml } from 'yaml';
import { build, transformSync } from 'esbuild';
import { compileFunction, runInNewContext } from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import type { preflightDispatchStack } from '@papercusp/tooldef';
import type { CapabilityEnvelopeVerdict, DispatchProjectedDeps } from '@papercusp/tooldef';
import type { EnvelopeDecision, evaluateCapabilityEnvelope } from '../capability-envelope/policy';
import type { evaluateSessionConfinement } from '../capability-envelope/session-confinement';
import type { SessionConfinementResolver } from '../capability-envelope/session-confinement-port';
import type { AuditModeMutationGuardDeps } from '../capability-envelope/audit-mode-guard';
import type { envelopeRoleOverrides, envelopeProtectedAdditions } from '../capability-envelope-overrides';
import { parseBlueprintSourceDocument, replayAgentSpecification, specificationPrompt } from '@papercusp/orchestrator/blueprint';
import type { BlueprintSourceLocation } from '../blueprint/installed-blueprints';
import type { RoleManifest } from '../role-registry';
import type { LoadedPlugin, LoaderOptions, PluginDiscoveryInventory } from '@papercusp/plugin-loader';
import type { listIdentitySources } from './source';
import type { UnifiedToolContext, KernelContextState, KernelEnforcementRequest,
  KernelEnforcementResult, sameKernelRevision } from '@papercusp/tooldef';
import type { FlagAttestation } from '@papercusp/flags/server';
import type { EnforceAppKeyScopeDeps } from '../connected-apps/enforce';
import type { EnforceInheritedPolicyDeps } from '../governance-policy/enforce';
import type { KernelEnforcementPort } from '@papercusp/tooldef';
import type { checkIdentityGrantKernel } from '../capability-envelope/identity-grants-port';
import type { PlanExecutionGuardDeps } from '../agent-tools/plans/plan-execution-guard';
import type { resolveMcpName } from '@papercusp/agent-mcp';

type IdopControlState = Awaited<ReturnType<typeof import('../projected-tool-deps').readControlAnchorKernelState>>;
export type IdopInnerKernelPorts = {
  readState: (request: KernelEnforcementRequest) => Promise<IdopControlState>;
  resolveIdentity: AuditModeMutationGuardDeps['resolveIdentity'];
  readPolicy: NonNullable<Parameters<typeof checkIdentityGrantKernel>[3]>;
  readOperationEffectClaim: NonNullable<Parameters<typeof checkIdentityGrantKernel>[4]>;
  resolveTool: typeof resolveMcpName;
  runtime: { pid: number; processId: string | null };
  /** Replay a captured convergence outcome/state sequence; never install the live writer. */
  converge: typeof import('../agent-tools/coordination/control-anchor').convergeActivationToLaunchRecord;
  plan: Required<Pick<PlanExecutionGuardDeps, 'readBindings' | 'resolveGoal' | 'checkPlan'>>;
};
type IdopAppPermissionPorts = Required<Pick<EnforceAppKeyScopeDeps,
  'loadRow' | 'loadAccessTokenRow' | 'lookupTool' | 'loadSpendStatus' | 'now'>>;
type IdopOrganizationPermissionPorts = Required<EnforceInheritedPolicyDeps>;

/** Select unchanged canonical declarations and their local dependencies. Keep
 * original declaration order so const initializers retain their dependencies. */
function idopSourceDeclarations(path: string, source: string, names: string[],
  bindings: Record<string, unknown>, closure: boolean) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, string[]>();
  for (const statement of file.statements) {
    if ((ts.isFunctionDeclaration(statement) && statement.body || ts.isClassDeclaration(statement)) && statement.name) {
      const name = statement.name.text;
      declarations.set(name, [...declarations.get(name) ?? [], statement.getText(file)]);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          const name = declaration.name.text;
          declarations.set(name, [...declarations.get(name) ?? [], `const ${declaration.getText(file)};`]);
        }
      }
    }
  }
  const selected = [...names];
  if (closure) for (let index = 0; index < selected.length; index++) {
    const snippets = declarations.get(selected[index]);
    if (!snippets) continue;
    const js = transformSync(snippets.join('\n'), { loader: 'ts', format: 'cjs' }).code;
    const tree = ts.createSourceFile(path, js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && declarations.has(node.text) && !Object.hasOwn(bindings, node.text) &&
          !selected.includes(node.text) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) selected.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  for (const name of selected) if (declarations.get(name)?.length !== 1) {
    throw new Error(`IDOP missing canonical host declaration: ${path}#${name}`);
  }
  return { file, declarations, selected: [...declarations.keys()].filter(name => selected.includes(name)) };
}

export const IDOP_P001_BASELINE_REL = 'docs/evidence/idop-p001-baseline-2026-10-22.json';
export const IDOP_P001_PROMPT_REL = 'apps/operator/prompts/papercusp-su.codex.md';

export type IdopPromptObservation = {
  sourceSession: {
    ownerId: string; nativeSessionId: string; advSessionId: number;
    nativeMessageTimestamp: string; nativeMetaTimestamp: string;
    nativeRecordLine: number; nativeTranscript: string;
    sourceClosure: string; sourceClosureSha256: string; specificationRevision: string;
  };
  renderedPrompt: { sha256: string; bytes: number; characters: number; frozenPath: string };
  nativeDelivery: {
    recordSha256: string; completeAgentsTextSha256: string; completeAgentsTextBytes: number;
    occurrences: number; prefix: string; suffix: string; excludedRenderedFields: string[];
  };
  files: Array<{ path: string; sha256: string; bytes: number }>;
};

/** Replay saved launch inputs and compare with an independently read native record.
 * Raw prompt bytes stay with the caller; the returned receipt contains only digests.
 */
export function inspectIdopP001PromptArchive(
  manifest: IdopPromptObservation,
  readBytes: (ref: string) => Buffer,
  originalNativeRecord: Buffer,
) {
  const requireProof = (condition: unknown, reason: string): void => {
    if (!condition) throw new Error(`IDOP prompt observation: ${reason}`);
  };
  requireProof(manifest.sourceSession.nativeSessionId.trim(), 'missing native session');
  requireProof(Number.isSafeInteger(manifest.sourceSession.nativeRecordLine) &&
    manifest.sourceSession.nativeRecordLine > 0, 'invalid native record line');
  requireProof(manifest.nativeDelivery.excludedRenderedFields.length === 0, 'render exclusions are not accepted');
  const files = new Map<string, Buffer>();
  for (const entry of manifest.files) {
    requireProof(!files.has(entry.path), 'duplicate archive reference');
    const bytes = readBytes(entry.path);
    requireProof(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'archive digest mismatch');
    files.set(entry.path, bytes);
  }
  const archived = (ref: string): Buffer => {
    const bytes = files.get(ref);
    requireProof(bytes !== undefined, 'unlisted archive reference');
    return bytes!;
  };
  const soleFile = (name: string): Buffer => {
    const matches = [...files.keys()].filter(ref => ref.endsWith(`/${name}`));
    requireProof(matches.length === 1, 'missing or ambiguous archive file');
    return archived(matches[0]);
  };
  // sourceClosure names the original observation; files names its frozen copy.
  // Verify that copy against the original's digest without rewriting provenance.
  const sourceBytes = soleFile('source-closure.json');
  requireProof(sha256(sourceBytes) === manifest.sourceSession.sourceClosureSha256, 'source closure digest mismatch');
  const closure = JSON.parse(sourceBytes.toString('utf8')) as {
    response: { truncated: boolean; rows: Array<{
      id: string; session_id: string; coord_owner_id: string;
      launch_spec: { specificationArtifact: unknown; specificationRevision: string };
    }> };
  };
  requireProof(closure.response.truncated === false && closure.response.rows.length === 1,
    'source session census is not exact');
  const session = closure.response.rows[0];
  requireProof(String(session.id) === String(manifest.sourceSession.advSessionId) &&
    session.session_id === manifest.sourceSession.nativeSessionId &&
    session.coord_owner_id === manifest.sourceSession.ownerId, 'source session mismatch');
  const replayed = replayAgentSpecification(session.launch_spec.specificationArtifact);
  requireProof(replayed.specificationRevision === manifest.sourceSession.specificationRevision &&
    session.launch_spec.specificationRevision === replayed.specificationRevision, 'specification revision mismatch');
  const prompt = archived(manifest.renderedPrompt.frozenPath);
  requireProof(prompt.length === manifest.renderedPrompt.bytes &&
    sha256(prompt) === manifest.renderedPrompt.sha256 &&
    // The capture's Python len counts Unicode code points, not UTF-16 units.
    Array.from(prompt.toString('utf8')).length === manifest.renderedPrompt.characters, 'render digest mismatch');
  requireProof(Buffer.from(specificationPrompt(replayed)).equals(prompt), 'replayed render differs');
  const meta = JSON.parse(soleFile('native-session-meta.jsonl').toString('utf8')) as {
    timestamp: string; type: string; payload: { id: string; session_id: string; timestamp: string };
  };
  // The payload records session creation; the outer timestamp records emission.
  requireProof(meta.type === 'session_meta' && meta.payload.timestamp === manifest.sourceSession.nativeMetaTimestamp &&
    meta.payload.id === manifest.sourceSession.nativeSessionId &&
    meta.payload.session_id === manifest.sourceSession.nativeSessionId, 'native session mismatch');
  const recordBytes = soleFile('native-agents-record.jsonl');
  requireProof(recordBytes.equals(originalNativeRecord), 'original native record differs');
  requireProof(sha256(recordBytes) === manifest.nativeDelivery.recordSha256, 'native record digest mismatch');
  const record = JSON.parse(recordBytes.toString('utf8')) as {
    timestamp: string; type: string;
    payload: { type: string; role: string; content: Array<{ type: string; text?: string }> };
  };
  requireProof(record.type === 'response_item' && record.payload.type === 'message' &&
    record.payload.role === 'user' && record.timestamp === manifest.sourceSession.nativeMessageTimestamp,
  'native message provenance mismatch');
  const texts = record.payload.content.filter(part => part.type === 'input_text' &&
    typeof part.text === 'string').map(part => part.text!);
  const expected = manifest.nativeDelivery.prefix + prompt.toString('utf8') + manifest.nativeDelivery.suffix;
  const matches = texts.filter(text => text === expected);
  requireProof(manifest.nativeDelivery.occurrences === 1 && matches.length === 1, 'native prompt differs');
  requireProof(Buffer.byteLength(matches[0]) === manifest.nativeDelivery.completeAgentsTextBytes &&
    sha256(matches[0]) === manifest.nativeDelivery.completeAgentsTextSha256, 'native text digest mismatch');
  return { nativeSessionId: session.session_id, specificationRevision: replayed.specificationRevision,
    renderedPromptSha256: sha256(prompt), nativeRecordSha256: sha256(recordBytes), filesChecked: files.size };
}

type Observation = {
  identity: string;
  stackRefs: string[];
  ownerId: string;
  nativeSessionId: string | null;
  activationEventId?: number;
  toolInvocationId?: number;
  observedAt: string;
  principal: string;
  status: 'observed' | 'tool-refused' | 'launch-refused';
  outputRef?: string;
  refusal?: string;
};

type CoverageInput = {
  population: {
    roles: Array<{ id: string }>;
    builtInIdentities: Array<{ id: string }>;
  };
  observations: Array<Pick<Observation, 'identity' | 'status' | 'ownerId' | 'observedAt' |
    'toolInvocationId' | 'activationEventId' | 'refusal'> & Partial<Pick<Observation, 'nativeSessionId'>>>;
};

/** A row-count floor cannot establish coverage of an independently enumerated population. */
export function inspectIdopP001Coverage(baseline: CoverageInput) {
  const population = [
    ...baseline.population.roles.map(({ id }) => `role:${id}`),
    ...baseline.population.builtInIdentities.map(({ id }) => `identity:${id}`),
  ].sort();
  const roles = new Set(baseline.population.roles.map(({ id }) => id));
  const expected = new Set(population);
  const checked = new Set<string>();
  const refused = new Set<string>();
  const invalid: string[] = [];
  for (const row of baseline.observations) {
    const key = `${roles.has(row.identity) ? 'role' : 'identity'}:${row.identity}`;
    const invocation = Number.isSafeInteger(row.toolInvocationId) && Number(row.toolInvocationId) > 0;
    const sourceSession = typeof row.nativeSessionId === 'string' && row.nativeSessionId.trim().length > 0;
    const receipt = invocation && (row.status === 'launch-refused'
      ? Boolean(row.refusal?.trim())
      : sourceSession && /^su-/.test(row.ownerId) && (row.status === 'observed' ||
          (row.status === 'tool-refused' && Boolean(row.refusal?.trim()))));
    // An invocation/owner cannot identify the source session; retain missing provenance as invalid.
    // Activation proves a worn layer, but does not by itself prove its effective tool set.
    if (!expected.has(key) || !receipt || !Number.isFinite(Date.parse(row.observedAt))) {
      invalid.push(key);
      continue;
    }
    if (row.status === 'observed') checked.add(key);
    else refused.add(key);
  }
  const missing = population.filter((key) => !checked.has(key) && !refused.has(key));
  return {
    complete: missing.length === 0 && refused.size === 0 && invalid.length === 0 && expected.size === population.length,
    population,
    checked: [...checked].sort(),
    refused: [...refused].sort(),
    missing,
    invalid: [...new Set(invalid)].sort(),
    duplicatePopulation: population.filter((key, index) => population.indexOf(key) !== index),
  };
}

type ComparisonJson = null | boolean | number | string | ComparisonJson[] | { [key: string]: ComparisonJson };
export const IDOP_P001_ROLE_POLICY_SOURCES = [
  'packages/operator-core/lib/capability-envelope/policy.ts',
  'packages/agent-mcp/src/gate-bypass.ts',
  'packages/agent-mcp/src/role-config.ts',
] as const;

/** Original host reads must be supplied independently of the compared policy.
 * These are authority/read ports, never tool handlers or lifecycle writers. */
export type IdopHostPermissionPorts = {
  resolveConfinement: SessionConfinementResolver;
  ensureConfinementReady: () => Promise<void>;
  audit: AuditModeMutationGuardDeps;
  roleOverrides: typeof envelopeRoleOverrides;
  protectedAdditions: typeof envelopeProtectedAdditions;
  getFlag: (key: string, distinctId: string) => Promise<boolean>;
};

type IdopStructuralKernelState = KernelContextState & {
  authorityUnavailable?: boolean;
  authorityUnavailableSources?: string[];
  authorityReadFailures?: Array<Record<string, unknown>>;
};

// UnifiedToolContext execution/telemetry services, not authority inputs. Keep
// the two capture codecs aligned; unknown executable fields still fail closed.
const idopContextServices = new Set([
  'log', 'signal', 'progress', 'emit', 'phases', 'activateTools', 'dispatchTool', 'tx',
  'metadata', 'spawn', 'secret', 'askUser', 'publishState',
]);

function idopHostContextKey(ctx: UnifiedToolContext, workspaceId: string) {
  const transaction = Object.getOwnPropertyDescriptor(ctx, 'tx');
  if (ctx.workspaceId !== workspaceId || transaction && 'value' in transaction && transaction.value !== undefined) {
    throw new Error('IDOP host snapshot context is outside its workspace or carries a transaction');
  }
  // Execution services are not authority. Do not consult the dispatcher's
  // deliberately throwing transaction accessor while preserving the caller.
  const data: Record<string, unknown> = {};
  if (Object.getOwnPropertySymbols(ctx).length) throw new Error('IDOP host snapshot context has uncaptured symbols');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(ctx))) {
    if (idopContextServices.has(key)) continue;
    if (!('value' in descriptor)) throw new Error('IDOP host snapshot context has an unreadable accessor');
    if (descriptor.value !== undefined) data[key] = descriptor.value;
  }
  return comparisonJson(idopAuthorityData(data));
}

function idopHostFlagValid(input: { key: string }, attestation: FlagAttestation) {
  return attestation?.key === input.key && typeof attestation.resolvedValue === 'boolean' &&
    typeof attestation.compiledDefault === 'boolean' && Number.isFinite(attestation.observedAtMs) && attestation.observedAtMs >= 0 &&
    ['release-build-lock', 'env-override', 'platform-mode-override', 'test-override',
      'override-store', 'process-cache', 'posthog', 'compiled-default'].includes(attestation.source) &&
    attestation.overrideRead?.storeConfigured === true &&
    ['not-read', 'cache-hit', 'store-load'].includes(attestation.overrideRead.kind) &&
    attestation.overrideRead.loadError === null;
}

/** Capture host READ inputs once, then replay those same bytes into both source
 * arms. Readers must come from the intended host; this helper does not boot a
 * substitute host, refresh its caches, or prove runtime/source containment.
 * Dispatch quota/prerequisite ports and the vault's SQL snapshot are separate.
 * An unconfigured or degraded flag store cannot certify current host policy. */
export async function captureIdopP001HostPermissionPorts(options: {
  workspaceId: string;
  contexts: readonly UnifiedToolContext[];
  flags: readonly { key: FlagAttestation['key']; distinctId: string }[];
}, readers: Omit<IdopHostPermissionPorts, 'getFlag'> & {
  readFlagAttestation: (key: FlagAttestation['key'], distinctId: string) => Promise<FlagAttestation>;
}) {
  const workspaceId = options.workspaceId;
  if (!workspaceId.trim() || workspaceId !== workspaceId.trim() || !options.contexts.length ||
      ![readers.resolveConfinement, readers.ensureConfinementReady, readers.audit?.resolveIdentity,
        readers.audit?.readModes, readers.roleOverrides, readers.protectedAdditions, readers.readFlagAttestation]
        .every(reader => typeof reader === 'function')) throw new Error('IDOP host snapshot requires explicit authority readers and contexts');
  const clone = <T,>(value: T): T => JSON.parse(comparisonJson(value as ComparisonJson)) as T;
  const contextKey = (ctx: UnifiedToolContext) => idopHostContextKey(ctx, workspaceId);
  const keys = options.contexts.map(contextKey);
  const flagKey = (key: string, distinctId: string) => JSON.stringify([key, distinctId]);
  const flagKeys = options.flags.map(row => flagKey(row.key, row.distinctId));
  if (new Set(keys).size !== keys.length || new Set(flagKeys).size !== flagKeys.length ||
      options.flags.some(row => !row.key.trim() || !row.distinctId.trim())) throw new Error('IDOP host snapshot has duplicate or blank inputs');
  await readers.ensureConfinementReady();
  const contexts = [];
  const modes = new Map<string, Array<{ mode: string }>>();
  for (let index = 0; index < options.contexts.length; index++) {
    const ctx = options.contexts[index];
    const identity = clone(readers.audit.resolveIdentity(ctx));
    if (!identity.ownerId?.trim() || identity.ownerId !== identity.ownerId.trim() || identity.workspaceId !== workspaceId) {
      throw new Error('IDOP host snapshot identity is missing or outside its workspace');
    }
    const modeKey = JSON.stringify([identity.workspaceId, identity.ownerId]);
    if (!modes.has(modeKey)) {
      const rows = clone(await readers.audit.readModes(identity.workspaceId, identity.ownerId));
      if (!Array.isArray(rows) || rows.some(row => typeof row?.mode !== 'string' || !row.mode.trim()) ||
          new Set(rows.map(row => row.mode)).size !== rows.length) throw new Error('IDOP host snapshot modes are malformed');
      modes.set(modeKey, rows);
    }
    const confinement = clone(await readers.resolveConfinement(ctx) ?? null);
    if (keys[index] !== contextKey(ctx)) throw new Error('IDOP host reader mutated its original context');
    contexts.push({ key: keys[index], identity, confinement });
  }
  const flags = [];
  for (const input of options.flags) {
    const attestation = clone(await readers.readFlagAttestation(input.key, input.distinctId));
    if (!idopHostFlagValid(input, attestation)) throw new Error('IDOP host snapshot flag authority is unconfigured, degraded or mismatched');
    flags.push({ ...input, attestation });
  }
  const roleOverrides = clone(readers.roleOverrides());
  const protectedAdditions = clone(readers.protectedAdditions());
  if (!roleOverrides || typeof roleOverrides !== 'object' || Array.isArray(roleOverrides) ||
      !Array.isArray(protectedAdditions) || protectedAdditions.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('IDOP host snapshot overrides are malformed');
  }
  const snapshot = { schemaVersion: 1 as const, scope: 'captured-host-permission-read-inputs' as const, workspaceId,
    contexts, modes: [...modes].map(([key, rows]) => ({ key, rows })), roleOverrides, protectedAdditions, flags };
  const bytes = comparisonJson(snapshot as unknown as ComparisonJson);
  return replayIdopP001HostPermissionSnapshot(snapshot, sha256(bytes));
}

type IdopP001HostSnapshot = {
  schemaVersion: 1; scope: 'captured-host-permission-read-inputs'; workspaceId: string;
  contexts: Array<{ key: string; identity: ReturnType<AuditModeMutationGuardDeps['resolveIdentity']>;
    confinement: Awaited<ReturnType<SessionConfinementResolver>> | null }>;
  modes: Array<{ key: string; rows: Array<{ mode: string }> }>;
  roleOverrides: ReturnType<typeof envelopeRoleOverrides>;
  protectedAdditions: ReturnType<typeof envelopeProtectedAdditions>;
  flags: Array<{ key: FlagAttestation['key']; distinctId: string; attestation: FlagAttestation }>;
};

/** Reload a saved original-host capture against its independently saved digest.
 * Neither authority readers nor the comparison process's flags/caches participate.
 * A valid digest establishes byte identity, not containing-host provenance. */
export function replayIdopP001HostPermissionSnapshot(raw: unknown, expectedSha256: string) {
  idopAuthorityData(raw); // reject getters/functions before canonicalization
  const bytes = comparisonJson(raw as ComparisonJson);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256) {
    throw new Error('IDOP host snapshot hash mismatch');
  }
  const snapshot = JSON.parse(bytes) as IdopP001HostSnapshot;
  const fail = (): never => { throw new Error('IDOP malformed host permission snapshot'); };
  const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value === value.trim();
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.scope !== 'captured-host-permission-read-inputs' ||
      Object.keys(snapshot).sort().join(',') !== 'contexts,flags,modes,protectedAdditions,roleOverrides,schemaVersion,scope,workspaceId' ||
      !text(snapshot.workspaceId) || !Array.isArray(snapshot.contexts) || !snapshot.contexts.length ||
      !Array.isArray(snapshot.modes) || !Array.isArray(snapshot.flags) || !snapshot.roleOverrides ||
      typeof snapshot.roleOverrides !== 'object' || Array.isArray(snapshot.roleOverrides) ||
      !Array.isArray(snapshot.protectedAdditions) || snapshot.protectedAdditions.some(value => !text(value))) fail();
  const workspaceId = snapshot.workspaceId;
  const byContext = new Map<string, IdopP001HostSnapshot['contexts'][number]>();
  const subjects = new Set<string>();
  for (const row of snapshot.contexts) {
    if (!row || Object.keys(row).sort().join(',') !== 'confinement,identity,key' || typeof row.key !== 'string' ||
        byContext.has(row.key) || !text(row.identity?.ownerId) || row.identity.workspaceId !== workspaceId) fail();
    try {
      const data = JSON.parse(row.key) as ComparisonJson;
      const context = idopAuthorityValue(data) as UnifiedToolContext;
      if (idopHostContextKey(context, workspaceId) !== row.key) fail();
    } catch { fail(); }
    byContext.set(row.key, row);
    subjects.add(JSON.stringify([workspaceId, row.identity.ownerId]));
  }
  const modes = new Map<string, IdopP001HostSnapshot['modes'][number]['rows']>();
  for (const row of snapshot.modes) {
    if (!row || Object.keys(row).sort().join(',') !== 'key,rows' || !subjects.has(row.key) || modes.has(row.key) ||
        !Array.isArray(row.rows) || row.rows.some(mode => !text(mode?.mode)) ||
        new Set(row.rows.map(mode => mode.mode)).size !== row.rows.length) fail();
    modes.set(row.key, row.rows);
  }
  if (modes.size !== subjects.size) fail();
  const flagKey = (key: string, distinctId: string) => JSON.stringify([key, distinctId]);
  const byFlag = new Map<string, FlagAttestation>();
  for (const row of snapshot.flags) {
    if (!row || Object.keys(row).sort().join(',') !== 'attestation,distinctId,key' || !text(row.key) ||
        !text(row.distinctId) || !idopHostFlagValid(row, row.attestation) || byFlag.has(flagKey(row.key, row.distinctId))) fail();
    byFlag.set(flagKey(row.key, row.distinctId), row.attestation);
  }
  const clone = <T,>(value: T): T => JSON.parse(comparisonJson(value as ComparisonJson)) as T;
  const context = (ctx: UnifiedToolContext) => {
    const row = byContext.get(idopHostContextKey(ctx, workspaceId));
    if (!row) throw new Error('IDOP host snapshot context was not captured');
    return row;
  };
  const ports: IdopHostPermissionPorts = {
    ensureConfinementReady: async () => {},
    resolveConfinement: ctx => clone(context(ctx).confinement),
    audit: { resolveIdentity: ctx => clone(context(ctx).identity), readModes: async (workspaceId, ownerId) => {
      const rows = modes.get(JSON.stringify([workspaceId, ownerId]));
      if (!rows) throw new Error('IDOP host snapshot mode identity was not captured');
      return clone(rows);
    } },
    roleOverrides: () => clone(snapshot.roleOverrides), protectedAdditions: () => clone(snapshot.protectedAdditions),
    getFlag: async (key, distinctId) => {
      const attestation = byFlag.get(flagKey(key, distinctId));
      if (!attestation) throw new Error('IDOP host snapshot flag lookup was not captured');
      return attestation.resolvedValue;
    },
  };
  return { snapshot: JSON.parse(bytes) as IdopP001HostSnapshot, sha256: expectedSha256, ports };
}

/** Lossless data-only authority codec. Tagged containers cannot collide with
 * user JSON, and preserve Map/Set/Date/undefined rather than silently erasing
 * a policy catalog, principal capabilities or an explicitly absent row. */
function idopAuthorityData(value: unknown, ancestors = new Set<object>()): ComparisonJson {
  if (value === undefined) return ['undefined'];
  if (Object.is(value, -0)) return ['negative-zero'];
  if (value === null || ['string', 'boolean'].includes(typeof value) ||
      typeof value === 'number' && Number.isFinite(value)) return value as ComparisonJson;
  if (typeof value !== 'object' || !value || ancestors.has(value)) throw new Error('IDOP authority requires acyclic data-only inputs');
  const next = new Set(ancestors).add(value);
  const encode = (entry: unknown) => idopAuthorityData(entry, next);
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    const prototype = value instanceof Date ? Date.prototype : value instanceof Map ? Map.prototype : Set.prototype;
    if (Object.getPrototypeOf(value) !== prototype || Reflect.ownKeys(value).length) {
      throw new Error('IDOP authority container has an unsupported prototype or extra properties');
    }
    if (value instanceof Date && Number.isFinite(value.getTime())) return ['date', value.toISOString()];
    if (value instanceof Map) return ['map', [...value].map(([key, entry]) => [encode(key), encode(entry)])];
    if (value instanceof Set) return ['set', [...value].map(encode)];
    throw new Error('IDOP authority has an invalid Date');
  }
  if (Array.isArray(value)) {
    if (Object.getOwnPropertyNames(value).length !== value.length + 1 || Object.getOwnPropertySymbols(value).length) {
      throw new Error('IDOP authority array has holes or extra properties');
    }
    return ['array', Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) throw new Error('IDOP authority has an unreadable accessor');
      return encode(descriptor.value);
    })];
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) {
    throw new Error('IDOP authority has an unsupported prototype or symbol');
  }
  return ['object', Object.entries(Object.getOwnPropertyDescriptors(value)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, descriptor]) => {
      if (!('value' in descriptor)) throw new Error('IDOP authority has an unreadable accessor');
      return [key, encode(descriptor.value)];
    })];
}

function idopAuthorityValue(data: ComparisonJson): unknown {
  if (!Array.isArray(data)) return data;
  const [kind, body] = data;
  const entries = body as ComparisonJson[];
  switch (kind) {
    case 'undefined': return undefined;
    case 'negative-zero': return -0;
    case 'date': return new Date(body as string);
    case 'array': return entries.map(idopAuthorityValue);
    case 'set': return new Set(entries.map(idopAuthorityValue));
    case 'map': return new Map(entries.map(entry => {
      const [key, value] = entry as ComparisonJson[];
      return [idopAuthorityValue(key), idopAuthorityValue(value)];
    }));
    case 'object': return Object.fromEntries(entries.map(entry => {
      const [key, value] = entry as [string, ComparisonJson];
      return [key, idopAuthorityValue(value)];
    }));
    default: throw new Error('IDOP invalid authority data tag');
  }
}

function idopKernelContextData(ctx: UnifiedToolContext, workspaceId: string) {
  if (ctx.workspaceId !== workspaceId) throw new Error('IDOP kernel snapshot has a foreign workspace');
  if (Object.getOwnPropertySymbols(ctx).length) throw new Error('IDOP kernel snapshot context has uncaptured symbols');
  const data: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(ctx))) {
    if (key === 'tx' && 'value' in descriptor && descriptor.value !== undefined) throw new Error('IDOP kernel snapshot carries a transaction');
    if (idopContextServices.has(key)) continue;
    if (!('value' in descriptor)) throw new Error('IDOP kernel snapshot has a context accessor');
    data[key] = descriptor.value;
  }
  return data;
}

function idopKernelRequestData(request: KernelEnforcementRequest, workspaceId: string) {
  if (Object.getOwnPropertySymbols(request).length) throw new Error('IDOP kernel snapshot request has uncaptured symbols');
  const data: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(request))) {
    if (key === 'registerPartialAudit') continue; // telemetry, never authority
    if (!('value' in descriptor)) throw new Error('IDOP kernel snapshot has a request accessor');
    data[key] = key === 'ctx' ? idopKernelContextData(request.ctx, workspaceId) : descriptor.value;
  }
  return data;
}

const idopKernelLookupKey = (port: string, args: unknown) => comparisonJson([port, idopAuthorityData(args)]);
type IdopP001KernelSnapshot = {
  schemaVersion: 1;
  scope: 'captured-original-kernel-permission-read-inputs';
  workspaceId: string;
  runtime: ComparisonJson;
  organizationInstalled: boolean;
  stateCounts: [string, number][];
  convergence: ComparisonJson;
  entries: { key: string; value: ComparisonJson }[];
};

/** Snapshot the ORIGINAL read ports used by the existing inner/outer adapters.
 * The caller independently supplies the lookup domain; uncaptured reads refuse.
 * This is a read-input snapshot, not a containing-runtime or population proof.
 * Convergence accepts only already-recorded outcomes with evidence refs: this
 * helper has no writer port. State re-reads capture the requested original
 * sequence, and each replay arm gets its own bounded cursor. */
export async function captureIdopP001KernelPermissionPorts(options: {
  workspaceId: string;
  requests: readonly { request: KernelEnforcementRequest; stateReadCount?: number }[];
  policyInputs: readonly Parameters<IdopInnerKernelPorts['readPolicy']>[0][];
  operationClaims: readonly Parameters<IdopInnerKernelPorts['readOperationEffectClaim']>[0][];
  toolNames: readonly string[];
  apps: readonly { appId: string; tokenIds: readonly string[] }[];
  convergence: readonly { args: [string, string, number, Parameters<IdopInnerKernelPorts['converge']>[3]];
    result: boolean; evidenceRefs: readonly string[] }[];
}, readers: {
  inner: Omit<IdopInnerKernelPorts, 'converge'>;
  app: IdopAppPermissionPorts;
  organization: IdopOrganizationPermissionPorts | null;
}) {
  const workspaceId = options.workspaceId;
  if (!workspaceId?.trim() || workspaceId !== workspaceId.trim() || !options.requests.length ||
      !Number.isSafeInteger(readers.inner?.runtime?.pid) || readers.inner.runtime.pid <= 0 ||
      !(readers.inner.runtime.processId === null || typeof readers.inner.runtime.processId === 'string') ||
      ![readers.inner.readState, readers.inner.resolveIdentity, readers.inner.readPolicy,
        readers.inner.readOperationEffectClaim, readers.inner.resolveTool, readers.inner.plan?.readBindings,
        readers.inner.plan?.resolveGoal, readers.inner.plan?.checkPlan, readers.app?.loadRow,
        readers.app?.loadAccessTokenRow, readers.app?.loadSpendStatus, readers.app?.lookupTool, readers.app?.now,
        ...(readers.organization === null ? [] : [readers.organization?.loadChain, readers.organization?.now])]
        .every(port => typeof port === 'function')) throw new Error('IDOP kernel snapshot requires explicit original authority ports');
  const originalRuntime = idopAuthorityData(readers.inner.runtime);
  const contextData = (ctx: UnifiedToolContext) => idopKernelContextData(ctx, workspaceId);
  const requestData = (request: KernelEnforcementRequest) => idopKernelRequestData(request, workspaceId);
  const keyFor = idopKernelLookupKey;
  const saved = new Map<string, ComparisonJson>();
  const capture = async (port: string, args: unknown, read: () => unknown) => {
    const key = keyFor(port, args);
    if (!saved.has(key)) {
      const value = await read();
      if (keyFor(port, args) !== key) throw new Error('IDOP kernel authority reader mutated its original input');
      saved.set(key, idopAuthorityData(value));
    }
    return idopAuthorityValue(saved.get(key)!);
  };
  const stateCounts = new Map<string, number>();
  for (const input of options.requests) {
    const count = input.stateReadCount ?? 1;
    const key = keyFor('state', requestData(input.request));
    if (!Number.isSafeInteger(count) || count < 1 || count > 100 || stateCounts.has(key)) {
      throw new Error('IDOP kernel snapshot has duplicate requests or invalid state sequence length');
    }
    stateCounts.set(key, count);
    const contextBefore = keyFor('context', contextData(input.request.ctx));
    const identity = await capture('identity', contextData(input.request.ctx), () => readers.inner.resolveIdentity(input.request.ctx)) as
      ReturnType<IdopInnerKernelPorts['resolveIdentity']>;
    if (!identity.ownerId?.trim() || identity.workspaceId !== workspaceId) throw new Error('IDOP kernel snapshot identity is missing or foreign');
    for (let index = 0; index < count; index++) {
      await capture('state', [requestData(input.request), index], () => readers.inner.readState(input.request));
    }
    const subject = [identity.ownerId, workspaceId];
    const bindings = await capture('plan.bindings', subject, () => readers.inner.plan.readBindings(identity.ownerId, workspaceId)) as
      Awaited<ReturnType<IdopInnerKernelPorts['plan']['readBindings']>>;
    await capture('plan.goal', subject, () => readers.inner.plan.resolveGoal(identity.ownerId, workspaceId));
    for (const binding of bindings) await capture('plan.check', [binding, workspaceId], () => readers.inner.plan.checkPlan(binding, workspaceId));
    if (contextBefore !== keyFor('context', contextData(input.request.ctx)) || key !== keyFor('state', requestData(input.request))) {
      throw new Error('IDOP kernel reader mutated original request or context');
    }
  }
  for (const input of options.policyInputs) {
    if (input.workspaceId !== workspaceId) throw new Error('IDOP kernel policy has a foreign workspace');
    await capture('policy', input, () => readers.inner.readPolicy(input));
  }
  for (const claim of options.operationClaims) {
    if (claim.workspaceId !== workspaceId) throw new Error('IDOP kernel claim has a foreign workspace');
    await capture('operation', claim, () => readers.inner.readOperationEffectClaim(claim));
  }
  if (new Set(options.toolNames).size !== options.toolNames.length ||
      options.toolNames.some(name => !name.trim()) || options.requests.some(input => !options.toolNames.includes(input.request.toolName))) {
    throw new Error('IDOP kernel tool catalog omitted a request or has duplicate/blank names');
  }
  for (const name of options.toolNames) {
    // Identity grant evaluation consumes only the resolved canonical MCP name.
    // No handler, schema callback or other executable registry value is copied.
    await capture('tool.canonical', name, () => {
      const tool = readers.inner.resolveTool(name);
      return tool === undefined ? undefined : { expose: { mcp: tool.expose.mcp && { name: tool.expose.mcp.name } } };
    });
    await capture('tool.app', name, () => readers.app.lookupTool(name));
  }
  const appNow = await capture('app.now', [], () => readers.app.now()) as Date;
  if (!(appNow instanceof Date)) throw new Error('IDOP kernel app clock is not a Date');
  for (const app of options.apps) {
    if (!app.appId.trim() || new Set(app.tokenIds).size !== app.tokenIds.length || app.tokenIds.some(token => !token.trim())) {
      throw new Error('IDOP kernel app inputs are malformed');
    }
    await capture('app.row', app.appId, () => readers.app.loadRow(app.appId));
    await capture('app.spend', [app.appId, appNow], () => readers.app.loadSpendStatus(app.appId, new Date(appNow)));
    for (const token of app.tokenIds) await capture('app.token', [token, app.appId], () => readers.app.loadAccessTokenRow(token, app.appId));
  }
  if (readers.organization !== null) {
    const organization = readers.organization;
    const now = await capture('organization.now', [], () => organization.now());
    if (!(now instanceof Date)) throw new Error('IDOP kernel organization clock is not a Date');
    await capture('organization.chain', workspaceId, () => organization.loadChain(workspaceId));
  }
  const convergenceKeys = new Set<string>();
  for (const outcome of options.convergence) {
    const [ownerId, scope, generation, revision] = outcome.args;
    const key = keyFor('convergence', outcome.args);
    if (!ownerId.trim() || scope !== workspaceId || !Number.isSafeInteger(generation) || generation < 0 ||
        !revision?.specificationRevision || !revision.stateRevision || typeof outcome.result !== 'boolean' ||
        !outcome.evidenceRefs.length || outcome.evidenceRefs.some(ref => !ref.trim()) || convergenceKeys.has(key)) {
      throw new Error('IDOP kernel convergence requires unique captured outcomes and evidence');
    }
    convergenceKeys.add(key);
    await capture('convergence', outcome.args, () => outcome.result);
  }
  if (comparisonJson(originalRuntime) !== comparisonJson(idopAuthorityData(readers.inner.runtime))) {
    throw new Error('IDOP kernel reader mutated original runtime');
  }
  const snapshot: IdopP001KernelSnapshot = { schemaVersion: 1, scope: 'captured-original-kernel-permission-read-inputs', workspaceId,
    runtime: originalRuntime, organizationInstalled: readers.organization !== null,
    stateCounts: [...stateCounts], convergence: idopAuthorityData(options.convergence),
    entries: [...saved].map(([key, value]) => ({ key, value })) };
  const bytes = comparisonJson(snapshot as unknown as ComparisonJson);
  return replayIdopP001KernelPermissionSnapshot(snapshot, sha256(bytes));
}

/** Rehydrate only the supplied, hash-bound read inputs. No live reader, writer,
 * clock or registry is consulted. The expected digest must come from the saved
 * capture receipt; recomputing it from an untrusted file proves no provenance. */
export function replayIdopP001KernelPermissionSnapshot(raw: unknown, expectedSha256: string) {
  // Reject accessors/executable values before canonical JSON can read them.
  idopAuthorityData(raw);
  const bytes = comparisonJson(raw as ComparisonJson);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256) {
    throw new Error('IDOP kernel snapshot hash mismatch');
  }
  const snapshot = JSON.parse(bytes) as IdopP001KernelSnapshot;
  const fail = (): never => { throw new Error('IDOP malformed kernel permission snapshot'); };
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.scope !== 'captured-original-kernel-permission-read-inputs' ||
      Object.keys(snapshot).sort().join(',') !== 'convergence,entries,organizationInstalled,runtime,schemaVersion,scope,stateCounts,workspaceId' ||
      typeof snapshot.workspaceId !== 'string' || !snapshot.workspaceId.trim() || snapshot.workspaceId !== snapshot.workspaceId.trim() ||
      typeof snapshot.organizationInstalled !== 'boolean' || !Array.isArray(snapshot.entries) ||
      !Array.isArray(snapshot.stateCounts) || !snapshot.stateCounts.length) fail();
  const workspaceId = snapshot.workspaceId;
  const decode = (data: ComparisonJson) => {
    try {
      const value = idopAuthorityValue(data);
      if (comparisonJson(idopAuthorityData(value)) !== comparisonJson(data)) fail();
      return value;
    } catch { return fail(); }
  };
  const runtime = decode(snapshot.runtime) as IdopInnerKernelPorts['runtime'];
  if (!runtime || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 0 ||
      !(runtime.processId === null || typeof runtime.processId === 'string')) fail();
  const keyFor = idopKernelLookupKey;
  const allowed = new Set(['identity', 'state', 'policy', 'operation', 'tool.canonical', 'tool.app',
    'plan.bindings', 'plan.goal', 'plan.check', 'app.now', 'app.row', 'app.spend', 'app.token',
    'organization.now', 'organization.chain', 'convergence']);
  const saved = new Map<string, ComparisonJson>();
  const decodedKeys = new Map<string, { port: string; args: unknown }>();
  for (const entry of snapshot.entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'key,value' || typeof entry.key !== 'string' || saved.has(entry.key)) fail();
    let key: ComparisonJson;
    try { key = JSON.parse(entry.key); } catch { return fail(); }
    if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== 'string' || !allowed.has(key[0])) return fail();
    const port = key[0] as string, args = decode(key[1]);
    if (keyFor(port, args) !== entry.key) fail();
    decode(entry.value);
    saved.set(entry.key, entry.value);
    decodedKeys.set(entry.key, { port, args });
  }
  const get = <T,>(port: string, args: unknown): T => {
    const key = keyFor(port, args);
    if (!saved.has(key)) throw new Error(`IDOP kernel authority lookup was not captured: ${port}`);
    return idopAuthorityValue(saved.get(key)!) as T;
  };
  const stateCounts = new Map<string, number>();
  const stateKeys = new Set<string>();
  for (const row of snapshot.stateCounts) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' ||
        !Number.isSafeInteger(row[1]) || row[1] < 1 || row[1] > 100 || stateCounts.has(row[0])) fail();
    let key: ComparisonJson;
    try { key = JSON.parse(row[0]); } catch { return fail(); }
    if (!Array.isArray(key) || key.length !== 2 || key[0] !== 'state') return fail();
    const request = decode(key[1]) as KernelEnforcementRequest;
    if (!request?.ctx || keyFor('state', idopKernelRequestData(request, workspaceId)) !== row[0]) fail();
    const identity = get<ReturnType<IdopInnerKernelPorts['resolveIdentity']>>('identity', idopKernelContextData(request.ctx, workspaceId));
    if (!identity?.ownerId?.trim() || identity.workspaceId !== workspaceId) fail();
    get('tool.canonical', request.toolName);
    get('tool.app', request.toolName);
    const subject = [identity.ownerId, workspaceId];
    const bindings = get<Awaited<ReturnType<IdopInnerKernelPorts['plan']['readBindings']>>>('plan.bindings', subject);
    if (!Array.isArray(bindings)) fail();
    get('plan.goal', subject);
    for (const binding of bindings) get('plan.check', [binding, workspaceId]);
    stateCounts.set(row[0], row[1]);
    for (let index = 0; index < row[1]; index++) {
      get('state', [request, index]);
      stateKeys.add(keyFor('state', [request, index]));
    }
  }
  if (!(get('app.now', []) instanceof Date)) fail();
  if (snapshot.organizationInstalled) {
    if (!(get('organization.now', []) instanceof Date)) fail();
    get('organization.chain', workspaceId);
  }
  const convergence = decode(snapshot.convergence) as Parameters<typeof captureIdopP001KernelPermissionPorts>[0]['convergence'];
  if (!Array.isArray(convergence)) fail();
  const convergenceKeys = new Set<string>();
  for (const outcome of convergence) {
    if (!outcome || !Array.isArray(outcome.args) || outcome.args.length !== 4 ||
        typeof outcome.args[0] !== 'string' || !outcome.args[0].trim() || outcome.args[1] !== workspaceId ||
        !Number.isSafeInteger(outcome.args[2]) || outcome.args[2] < 0 || !outcome.args[3]?.specificationRevision ||
        !outcome.args[3].stateRevision || typeof outcome.result !== 'boolean' || !Array.isArray(outcome.evidenceRefs) ||
        !outcome.evidenceRefs.length || outcome.evidenceRefs.some((ref: unknown) => typeof ref !== 'string' || !ref.trim())) fail();
    const key = keyFor('convergence', outcome.args);
    if (convergenceKeys.has(key) || get('convergence', outcome.args) !== outcome.result) fail();
    convergenceKeys.add(key);
  }
  for (const [key, { port }] of decodedKeys) {
    if (port === 'state' && !stateKeys.has(key) || port === 'convergence' && !convergenceKeys.has(key) ||
        port.startsWith('organization.') && !snapshot.organizationInstalled) fail();
  }
  const contextData = (ctx: UnifiedToolContext) => idopKernelContextData(ctx, workspaceId);
  const requestData = (request: KernelEnforcementRequest) => idopKernelRequestData(request, workspaceId);
  return { snapshot: JSON.parse(bytes) as IdopP001KernelSnapshot, sha256: expectedSha256, createPorts: () => {
    const cursors = new Map<string, number>();
    const inner: IdopInnerKernelPorts = {
      runtime: idopAuthorityValue(snapshot.runtime) as IdopInnerKernelPorts['runtime'],
      resolveIdentity: ctx => get('identity', contextData(ctx)),
      readState: async request => {
        const data = requestData(request);
        const key = keyFor('state', data);
        const index = cursors.get(key) ?? 0;
        if (index >= (stateCounts.get(key) ?? 0)) throw new Error('IDOP kernel state sequence was not captured or is exhausted');
        cursors.set(key, index + 1);
        return get('state', [data, index]);
      },
      readPolicy: async input => get('policy', input), readOperationEffectClaim: async claim => get('operation', claim),
      resolveTool: name => {
        const tool = get<ReturnType<IdopInnerKernelPorts['resolveTool']>>('tool.canonical', name);
        return tool && new Proxy(tool, { get: (target, property) => {
          if (property !== 'expose') throw new Error(`IDOP kernel tool metadata was not captured: ${String(property)}`);
          return target.expose;
        } });
      },
      converge: async (owner, scope, generation, revision, sql) => {
        if (sql !== undefined) throw new Error('IDOP kernel replay cannot accept a convergence writer');
        return get('convergence', [owner, scope, generation, revision]);
      },
      plan: { readBindings: async (owner, scope) => get('plan.bindings', [owner, scope]),
        resolveGoal: async (owner, scope) => get('plan.goal', [owner, scope]),
        checkPlan: async (binding, scope) => get('plan.check', [binding, scope]) },
    };
    const app: IdopAppPermissionPorts = { now: () => get('app.now', []),
      lookupTool: name => get('tool.app', name), loadRow: async id => get('app.row', id),
      loadAccessTokenRow: async (token, id) => get('app.token', [token, id]),
      loadSpendStatus: async (id, now) => get('app.spend', [id, now]) };
    const organization: IdopOrganizationPermissionPorts | null = snapshot.organizationInstalled ?
      { now: () => get('organization.now', []), loadChain: async scope => get('organization.chain', scope) } : null;
    return { inner, app, organization };
  } };
}

/** Execute the real role-policy module with its own source dependencies. In
 * particular, the old policy must not import today's role registry or testing
 * bypass. This is one comparison adapter, not the complete dispatch/vault proof.
 * Unrecognised imports fail closed instead of falling through to the host graph.
 */
export function loadIdopP001RolePermissionReader(options: {
  root: string;
  revision: string;
  testingFullAccess: 'off' | 'default';
}) {
  if (options.revision !== 'working-tree' && !/^[a-f0-9]{40}$/.test(options.revision)) {
    throw new Error('IDOP role comparison requires an exact source revision');
  }
  const readSource = (path: string) => {
    const text = options.revision === 'working-tree' ? readFileSync(join(options.root, path), 'utf8') :
      execFileSync('git', ['-C', options.root, 'show', `${options.revision}:${path}`], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      });
    return { path, text, sha256: sha256(text) };
  };
  const sources = IDOP_P001_ROLE_POLICY_SOURCES.map(readSource);
  const sourceByPath = new Map<string, typeof sources[number]>(sources.map(source => [source.path, source]));
  const loaded = new Map<string, { exports: Record<string, unknown> }>();
  const externalDependencies = new Map<string, { name: string; version: string; lockSha256: string }>();
  const disabledHostPorts = new Set<string>();
  const hostFunctions = new Map<string, { path: string; name: string; sha256: string }>();
  const confinementPath = 'packages/operator-core/lib/capability-envelope/session-confinement.ts';
  const sourceAt = (path: string) => {
    if (!sourceByPath.has(path)) sourceByPath.set(path, readSource(path));
    return sourceByPath.get(path)!;
  };
  // Select the actual function declaration, not a copied implementation or a
  // regex-delimited approximation. Importing projected-tool-deps wholesale
  // would initialize the comparison host's live writers and registries.
  const sourceDeclarations = <T,>(path: string, names: string[], bindings: Record<string, unknown>,
    optional: string[] = [], closure = false): T => {
    const source = sourceAt(path);
    const available = idopSourceDeclarations(path, source.text, [], {}, false).declarations;
    const { declarations, selected } = idopSourceDeclarations(path, source.text,
      [...names, ...optional.filter(name => available.has(name))], bindings, closure);
    const text = selected.map(name => {
      const matches = declarations.get(name);
      if (matches?.length !== 1) throw new Error(`IDOP missing canonical host declaration: ${path}#${name}`);
      hostFunctions.set(`${path}#${name}`, { path, name, sha256: sha256(matches[0]) });
      return matches[0];
    }).join('\n');
    const module = { exports: {} as T };
    const code = transformSync(`${text}\nmodule.exports = { ${selected.join(', ')} };`, {
      loader: 'ts', format: 'cjs', target: 'node22', sourcefile: path, supported: { 'dynamic-import': false },
    }).code;
    runInNewContext(code, { ...bindings, module, exports: {}, Date, URL, console }, { filename: path, timeout: 2_000 });
    return module.exports;
  };
  const sourceFunction = <T,>(path: string, name: string, bindings: Record<string, unknown>): T => {
    const result = sourceDeclarations<Record<string, T>>(path, [name], bindings)[name];
    if (typeof result !== 'function') throw new Error(`IDOP invalid canonical host function: ${name}`);
    return result;
  };
  const external = (name: string) => {
    const key = `node_modules/${name}`;
    const lockText = options.revision === 'working-tree' ? readFileSync(join(options.root, 'package-lock.json'), 'utf8') :
      execFileSync('git', ['-C', options.root, 'show', `${options.revision}:package-lock.json`],
        { encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
    const locked = JSON.parse(lockText).packages[key];
    const installedLock = JSON.parse(readFileSync(join(options.root, 'package-lock.json'), 'utf8')).packages[key];
    const installed = JSON.parse(readFileSync(join(options.root, key, 'package.json'), 'utf8'));
    if (!locked?.version || installed.version !== locked.version || JSON.stringify(locked) !== JSON.stringify(installedLock)) {
      throw new Error(`IDOP argument comparison dependency mismatch: ${name}`);
    }
    externalDependencies.set(name, { name, version: installed.version, lockSha256: sha256(JSON.stringify(locked)) });
    return createRequire(join(options.root, 'package.json'))(name);
  };
  const dependencies: Record<string, string> = {
    '@papercusp/agent-mcp/gate-bypass': IDOP_P001_ROLE_POLICY_SOURCES[1],
    '@papercusp/agent-mcp/role-config': IDOP_P001_ROLE_POLICY_SOURCES[2],
  };
  const load = (path: string): Record<string, unknown> => {
    const hit = loaded.get(path);
    if (hit) return hit.exports;
    const source = sourceAt(path);
    const module = { exports: {} as Record<string, unknown> };
    loaded.set(path, module);
    const code = transformSync(source.text, { loader: 'ts', format: 'cjs', target: 'node22', sourcefile: path }).code;
    runInNewContext(code, {
      module, exports: module.exports, Date,
      require: (name: string) => {
        if (path.startsWith('packages/operator-core/lib/') && name.startsWith('.')) {
          const dependency = relative(options.root, resolve(options.root, dirname(path), name)).replace(/\.js$/, '.ts');
          if (!dependency.startsWith('packages/operator-core/lib/')) {
            throw new Error(`IDOP argument comparison source escape: ${name}`);
          }
          const target = dependency.endsWith('.ts') ? dependency : `${dependency}.ts`;
          sourceAt(target);
          // Pin the imported bytes immediately, evaluate them on first use.
          // This preserves canonical pure validators without initializing their
          // unrelated DB-backed readers. A used unsupported import still fails.
          return new Proxy({}, {
            get: (_object, key) => load(target)[key as string],
            ownKeys: () => Reflect.ownKeys(load(target)),
            getOwnPropertyDescriptor: (_object, key) => {
              const descriptor = Object.getOwnPropertyDescriptor(load(target), key);
              return descriptor ? { ...descriptor, configurable: true } : undefined;
            },
          });
        }
        if (name === 'zod') return external(name);
        if (name === 'node:crypto') return { createHash };
        if (name === '@papercusp/db-org') {
          // Vault readers receive an explicit fixture/snapshot SQL handle.
          // Never let an omitted dependency open the comparison host's DB.
          disabledHostPorts.add('@papercusp/db-org.getOrgPg');
          return { getOrgPg: () => { throw new Error('IDOP vault comparison requires explicit SQL dependencies'); } };
        }
        if (!Object.hasOwn(dependencies, name)) throw new Error(`IDOP role comparison unpinned import: ${name}`);
        return load(dependencies[name]);
      },
      process: { env: Object.freeze(options.testingFullAccess === 'off' ?
        { PAPERCUSP_TESTING_FULL_ACCESS_ROLES: 'off' } : {}) },
    }, { filename: path, timeout: 2_000 });
    return module.exports;
  };
  const policy = load(IDOP_P001_ROLE_POLICY_SOURCES[0]);
  if (typeof policy.evaluateCapabilityEnvelope !== 'function') throw new Error('IDOP role comparison missing permission reader');
  const roles = load(IDOP_P001_ROLE_POLICY_SOURCES[2]).AGENT_ROLES;
  if (!Array.isArray(roles) || !roles.length || roles.some(role => typeof role !== 'string' || !role.trim()) ||
      new Set(roles).size !== roles.length) throw new Error('IDOP role comparison invalid role registry');
  const evaluate = policy.evaluateCapabilityEnvelope as typeof evaluateCapabilityEnvelope;
  return {
    revision: options.revision, testingFullAccess: options.testingFullAccess,
    roles: [...roles as string[]].sort(),
    get sources() { return [...sourceByPath.values()].map(({ text: _text, ...receipt }) => receipt); },
    get externalDependencies() { return [...externalDependencies.values()]; },
    get disabledHostPorts() { return [...disabledHostPorts]; },
    get hostFunctions() { return [...hostFunctions.values()]; },
    /** Use the gate's unchanged pure receipt declarations without initializing
     * agent-mcp/bootstrap or its live tool/schema registrations. */
    createAppliedReceiptReader: () => ({
      ...sourceDeclarations<Pick<typeof import('../capability-envelope/identity-grants-port'),
        'selectAppliedReceipt' | 'appliedOrCurrentIdentityArtifact' | 'resolveIdentityArtifact'>>(
        'packages/operator-core/lib/capability-envelope/identity-grants-port.ts',
        ['selectAppliedReceipt', 'appliedOrCurrentIdentityArtifact', 'resolveIdentityArtifact'],
        { replayAgentSpecification }, [], true),
      ...sourceDeclarations<Pick<typeof import('./wearer-authority'), 'identityWearerRole'>>(
        'packages/operator-core/lib/agent-identities/wearer-authority.ts', ['identityWearerRole'], {}, [], true),
    }),
    /** Canonical inner resolver, including the selected revision's identity,
     * convergence and (when present) plan guard. Only original host inputs are
     * supplied; neither an allow callback nor the live host graph is accepted.
     * This adapter is not a population capture or an acceptance certificate. */
    createInnerKernelReader: async (ports: IdopInnerKernelPorts) => {
      if (![ports.readState, ports.resolveIdentity, ports.readPolicy, ports.readOperationEffectClaim, ports.resolveTool,
        ports.converge, ports.plan?.readBindings, ports.plan?.resolveGoal, ports.plan?.checkPlan]
        .every(port => typeof port === 'function') || !Number.isSafeInteger(ports.runtime?.pid) || ports.runtime.pid <= 0 ||
        !(ports.runtime.processId === null || typeof ports.runtime.processId === 'string')) {
        throw new Error('IDOP inner kernel requires explicit authority readers and original runtime');
      }
      const generic = await loadIdopP001DispatchPermissionReader({ ...options, includeIdentityReplay: true });
      const select = <T,>(path: string, names: string[], bindings: Record<string, unknown>) =>
        sourceDeclarations<T>(path, names, bindings, [], true);
      const door = load('packages/operator-core/lib/capability-envelope/recovery-door.ts');
      const refusal = load('packages/operator-core/lib/capability-envelope/identity-refusal-contract.ts');
      const reach = load('packages/operator-core/lib/agent-identities/grant-provider-kinds.ts');
      const envelopePath = 'packages/operator-core/lib/capability-envelope/blueprint-envelopes.ts';
      const envelopeSource = ts.createSourceFile(envelopePath, sourceAt(envelopePath).text,
        ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const portablePolicy: Record<string, unknown> = {};
      // Only the selected source's imports may add replay dependencies. The
      // original arm predates category-rules.ts and must never read it.
      for (const statement of envelopeSource.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const name = statement.moduleSpecifier.text;
        if (name === '../governance-policy/category-rules' || name === '../governance-policy/inherited-policy') {
          Object.assign(portablePolicy, load(relative(options.root,
            resolve(options.root, dirname(envelopePath), name)) + '.ts'));
        }
      }
      const envelope = select<Record<string, unknown>>(envelopePath,
        ['identityGrantToolFailure', 'resolveIdentityGrantEnvelope'], { ...policy, ...refusal, ...reach, ...portablePolicy });
      const identity = select<{ checkIdentityGrantKernel: typeof checkIdentityGrantKernel }>(
        'packages/operator-core/lib/capability-envelope/identity-grants-port.ts', ['checkIdentityGrantKernel'], {
          ...door, ...refusal, ...reach, ...envelope,
          ...load('packages/operator-core/lib/capability-envelope/lazy-launch-record.ts'),
          // These names are the canonical default parameters, not an alternate
          // evaluator. No default policy/claim DB read can enter the sandbox.
          readIdentityGrantPolicy: ports.readPolicy, readCurrentOperationEffectClaim: ports.readOperationEffectClaim,
          replayAgentSpecification: generic.replayAgentSpecification,
          resolveMcpName: ports.resolveTool,
          pinModuleState: (_key: string, initialize: () => unknown) => initialize(),
          isHookReleasedOperationContinuationCall: (...args: unknown[]) => {
            const door = load('packages/operator-core/lib/released-operation-continuation-door.ts');
            return (door.isHookReleasedOperationContinuationCall as (...args: unknown[]) => unknown)(...args);
          },
        });
      const path = 'packages/operator-core/lib/projected-tool-deps.ts';
      // Inspect the resolver's own dependency graph. The old arm has no plan
      // guard; never graft one into it just because today's module imports it.
      const file = ts.createSourceFile(path, sourceAt(path).text, ts.ScriptTarget.Latest, true);
      const resolver = file.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
        .find(d => ts.isIdentifier(d.name) && d.name.text === 'controlAnchorKernelResolver');
      if (!resolver) throw new Error('IDOP missing canonical control resolver');
      const hasPlanGuard = /\bcheckPlanExecutionGuard\b/.test(resolver.getText(file));
      let plan: Record<string, unknown> = {};
      if (hasPlanGuard) {
        const timeout = select<Record<string, unknown>>('packages/operator-core/lib/bounded-timeout.ts',
          ['withBoundedTimeout'], { AbortController, setTimeout, clearTimeout,
            observeFallback: () => {}, activeWorkspaceId: () => null });
        disabledHostPorts.add('bounded-timeout.observeFallback');
        const constants = sourceDeclarations<Record<string, unknown>>(
          'packages/operator-core/lib/agent-tools/plans/plan-continuation-readiness.ts',
          ['PLAN_READINESS_PENDING', 'READINESS_PENDING_RETRY_AFTER_MS'], {});
        plan = select<Record<string, unknown>>('packages/operator-core/lib/agent-tools/plans/plan-execution-guard.ts',
          ['isPlanImplementationCall', 'checkPlanExecutionGuard'], {
            ...timeout, ...constants, parseShell: external('shell-quote').parse,
            readExecutionPlanBindings: ports.plan.readBindings, readExecutionPlanGoal: ports.plan.resolveGoal,
            checkExecutionPlan: ports.plan.checkPlan, performance,
          });
      }
      const inner = select<{ controlAnchorKernelResolver: KernelEnforcementPort }>(path,
        ['controlAnchorKernelResolver'], {
          ...plan, performance, process: { pid: ports.runtime.pid },
          resolveAgentIdentity: ports.resolveIdentity, sameKernelRevision: generic.sameKernelRevision,
          readControlAnchorKernelState: ports.readState,
          pinModuleState: (_key: string, initialize: () => unknown) => initialize(),
          getServingHostIdentity: () => ({ processId: ports.runtime.processId }),
          require: (name: string) => {
            if (name === './capability-envelope/identity-grants-port') return identity;
            if (name === './agent-tools/coordination/control-anchor') return { convergeActivationToLaunchRecord: ports.converge };
            throw new Error(`IDOP inner comparison unpinned import: ${name}`);
          }, ...door,
        }).controlAnchorKernelResolver;
      return { hasPlanGuard, genericSources: generic.sources, externalDependencies: generic.externalDependencies,
        evaluate: inner };
    },
    /** Preserve this revision's outer kernel ordering and policy implementations.
     * Every authority read is explicit. No default DB, shared host cache, alert
     * writer, tool handler or installed live resolver is initialized here.
     * The caller must supply the SAME revision's control-anchor/identity/plan
     * resolver, or explicitly attest its absence with null; this is not proof
     * of that inner resolver, current population or host installation state. */
    createOuterKernelReader: (ports: {
      app: IdopAppPermissionPorts;
      organization: IdopOrganizationPermissionPorts | null;
      resolveControlAnchor: KernelEnforcementPort | null;
      structural: KernelEnforcementPort;
    }): KernelEnforcementPort => {
      if (![ports.app?.loadRow, ports.app?.loadAccessTokenRow, ports.app?.lookupTool,
        ports.app?.loadSpendStatus, ports.app?.now, ports.structural].every(fn => typeof fn === 'function') ||
        ports.organization !== null && (![ports.organization?.loadChain, ports.organization?.now]
          .every(fn => typeof fn === 'function')) ||
        ports.resolveControlAnchor !== null && typeof ports.resolveControlAnchor !== 'function') {
        throw new Error('IDOP outer kernel requires explicit app, organization and control-anchor authority');
      }
      const principal = sourceDeclarations<Record<string, unknown>>(
        'packages/operator-core/lib/connected-apps/principal.ts',
        ['APP_PRINCIPAL_SLUG_PREFIX', 'ACCESS_TOKEN_SLUG_SEPARATOR'], {});
      const harness = sourceDeclarations<Pick<typeof import('../agent-tools/_harness-scope'), 'resolveConcreteHarnessSlug'>>(
        'packages/operator-core/lib/agent-tools/_harness-scope.ts',
        ['isAllHarnessSentinel', 'resolveHarnessScope', 'resolveConcreteHarnessSlug'], {});
      const spend = sourceDeclarations<Record<string, unknown>>('packages/operator-core/lib/connected-apps/spend.ts',
        ['LLM_RUNNING_TOOLS', 'SPEND_CAP_NEAR_RATIO', 'spendCapVerdict'], {
          BLUEPRINT_OPERATION_TOOLS: load('packages/operator-core/lib/blueprint/operation-tool-names.ts').BLUEPRINT_OPERATION_TOOLS,
        });
      const app = sourceDeclarations<Pick<typeof import('../connected-apps/enforce'), 'enforceAppKeyScope'>>(
        'packages/operator-core/lib/connected-apps/enforce.ts',
        ['APP_SCOPE_CODE_PREFIX', 'NATIVE_BOUNDARIES', 'deny', 'scopeRowsFor',
          'appPrincipalRefOfSlug', 'spendCapDenial', 'enforceAppKeyScope'], {
          ...principal, ...spend, ...harness,
          evaluateAppScopeChain: load('packages/operator-core/lib/connected-apps/scope-policy.ts').evaluateAppScopeChain,
        }, ['enforceAppKeyScopePolicy']);
      const organization = sourceDeclarations<Pick<typeof import('../governance-policy/enforce'), 'enforceInheritedPolicy'>>(
        'packages/operator-core/lib/governance-policy/enforce.ts',
        ['ORG_POLICY_CODE_PREFIX', 'GOVERNANCE_ADMIN_TOOLS', 'GOVERNANCE_ADMIN_ROUTE', 'isGovernanceAdminTool',
          'MODEL_KEYS', 'PROVIDER_KEYS', 'REGION_KEYS', 'URL_KEYS', 'DATA_USE_KEYS', 'DATA_CLASS_KEYS', 'PLUGIN_VERB',
          'strings', 'record', 'hostOf', 'governedRequestOf', 'deny', 'CACHE_TTL_MS', 'chainFor',
          'workspacePolicyJudge', 'enforceInheritedPolicy'], {
          ...load('packages/operator-core/lib/governance-policy/processing-route.ts'),
          ...load('packages/operator-core/lib/auth/hosted/customer-data-map.ts'),
          evaluateInheritedPolicy: load('packages/operator-core/lib/governance-policy/inherited-policy.ts').evaluateInheritedPolicy,
          state: { loader: null, cache: new Map() },
        });
      // Alerts do not affect the policy verdict. Omitting both optional writer
      // ports retains the canonical permission path without emitting anything.
      disabledHostPorts.add('connected-apps.raiseAlert');
      const appDependencies = { loadRow: ports.app.loadRow, loadAccessTokenRow: ports.app.loadAccessTokenRow,
        lookupTool: ports.app.lookupTool, loadSpendStatus: ports.app.loadSpendStatus, now: ports.app.now };
      const organizationDependencies = ports.organization === null ? {} :
        { loadChain: ports.organization.loadChain, now: ports.organization.now };
      const outer = sourceDeclarations<{ operatorKernelEnforcement: KernelEnforcementPort }>(
        'packages/operator-core/lib/projected-tool-deps.ts', ['operatorKernelEnforcement'], {
          enforceAppKeyScope: (request: KernelEnforcementRequest) => app.enforceAppKeyScope(request, appDependencies),
          enforceInheritedPolicy: (request: KernelEnforcementRequest) =>
            organization.enforceInheritedPolicy(request, organizationDependencies),
          kernelEnforcementResolver: ports.resolveControlAnchor,
          evaluateOperatorKernelRequest: (request: KernelEnforcementRequest, state: KernelContextState) =>
            ports.structural({ ...request, ctx: { ...request.ctx, kernelState: state } }),
        }).operatorKernelEnforcement;
      return async request => JSON.parse(JSON.stringify(await outer(request))) as KernelEnforcementResult;
    },
    /** The structural kernel's real source, before identity grant evaluation.
     * Resolve original authority independently and supply the SAME revision's
     * generic comparator; neither helper imports today's live kernel host.
     * This does not replace app/org/identity/plan/launch policy adapters. */
    createStructuralKernelReader: (ports: {
      resolveIdentity: AuditModeMutationGuardDeps['resolveIdentity'];
      sameKernelRevision: typeof sameKernelRevision;
    }) => {
      if (typeof ports.resolveIdentity !== 'function' || typeof ports.sameKernelRevision !== 'function') {
        throw new Error('IDOP structural kernel requires original identity and pinned revision readers');
      }
      const path = 'packages/operator-core/lib/projected-tool-deps.ts';
      const deny = sourceFunction<(code: string, reason: string, policyRevision?: string | null,
        audit?: KernelEnforcementResult['serverAudit']) => KernelEnforcementResult>(path, 'operatorKernelDenial', {});
      const evaluate = sourceFunction<(request: KernelEnforcementRequest,
        state: IdopStructuralKernelState | undefined) => KernelEnforcementResult>(path, 'evaluateOperatorKernelRequest', {
        operatorKernelDenial: deny, resolveAgentIdentity: ports.resolveIdentity, sameKernelRevision: ports.sameKernelRevision,
      });
      return (request: KernelEnforcementRequest, state?: IdopStructuralKernelState): KernelEnforcementResult =>
        JSON.parse(JSON.stringify(evaluate(request, state))) as KernelEnforcementResult;
    },
    /** The revision's real host gate, ready for that revision's canonical
     * dispatch preflight. Snapshot/SQL resolver provenance remains the caller's
     * obligation; a synthetic port proves wiring, never current population. */
    createHostEnvelopePort: (ports: IdopHostPermissionPorts): NonNullable<DispatchProjectedDeps['checkCapabilityEnvelope']> => {
      if (![ports.resolveConfinement, ports.ensureConfinementReady, ports.audit?.resolveIdentity,
        ports.audit?.readModes, ports.roleOverrides, ports.protectedAdditions, ports.getFlag]
        .every(port => typeof port === 'function')) throw new Error('IDOP host comparison requires every authority read port');
      const checkConfinement = sourceFunction<NonNullable<DispatchProjectedDeps['checkCapabilityEnvelope']>>(
        'packages/operator-core/lib/capability-envelope/session-confinement-port.ts', 'checkSessionConfinement', {
          state: { resolver: ports.resolveConfinement, ensureReady: ports.ensureConfinementReady },
          evaluateSessionConfinement: load(confinementPath).evaluateSessionConfinement,
          // This seam did not exist in the old source. Resolve only when the
          // selected function actually calls it; never graft today's door onto
          // the old gate or require a post-baseline file in the old graph.
          isHookReleasedOperationContinuationCall: (input: unknown) => {
            const door = load('packages/operator-core/lib/released-operation-continuation-door.ts') as
              Pick<typeof import('../released-operation-continuation-door'), 'isHookReleasedOperationContinuationCall'>;
            return door.isHookReleasedOperationContinuationCall(input as Parameters<typeof door.isHookReleasedOperationContinuationCall>[0]);
          },
          realpath, dirname, isAbsolute, relative, resolve,
        });
      const audit = load('packages/operator-core/lib/capability-envelope/audit-mode-guard.ts') as
        Pick<typeof import('../capability-envelope/audit-mode-guard'), 'checkAuditModeMutationGuard'>;
      const host = sourceFunction<NonNullable<DispatchProjectedDeps['checkCapabilityEnvelope']>>(
        'packages/operator-core/lib/projected-tool-deps.ts', 'checkCapabilityEnvelopeImpl', {
          checkSessionConfinement: checkConfinement,
          checkAuditModeMutationGuard: (input: Parameters<typeof audit.checkAuditModeMutationGuard>[0]) =>
            audit.checkAuditModeMutationGuard(input, ports.audit),
          evaluateCapabilityEnvelope: evaluate, ROLE_ENVELOPES: policy.ROLE_ENVELOPES,
          envelopeRoleOverrides: ports.roleOverrides, envelopeProtectedAdditions: ports.protectedAdditions,
          getFlag: ports.getFlag, FLAGS: load('libs/flags/src/types.ts').FLAGS,
        });
      return async input => {
        const result = await host(input);
        return result === null ? null : JSON.parse(JSON.stringify(result)) as CapabilityEnvelopeVerdict;
      };
    },
    evaluate: (input: Parameters<typeof evaluateCapabilityEnvelope>[0]): EnvelopeDecision => {
      // Cross-realm values must become plain host JSON for the comparison's
      // strict JSON guard. Neither adapter receives the other's mutable object.
      return JSON.parse(JSON.stringify(evaluate(structuredClone(input)))) as EnvelopeDecision;
    },
    /** Executes the canonical privilege-independent argument policy with the
     * caller's independently read ORIGINAL launch confinement, in each arm's
     * source graph. Host confinement resolution remains a separate proof. */
    evaluateArguments: (input: Parameters<typeof evaluateSessionConfinement>[0]) => {
      const decide = load(confinementPath).evaluateSessionConfinement as typeof evaluateSessionConfinement;
      if (typeof decide !== 'function') throw new Error('IDOP missing canonical argument permission reader');
      return JSON.parse(JSON.stringify(decide(structuredClone(input)))) as ReturnType<typeof evaluateSessionConfinement>;
    },
    /** Four vault policy seams, loaded from the SAME pinned graph as the role
     * and argument readers. SQL and recall search/embed ports are explicit;
     * these functions never acquire the comparison host's default DB. */
    get vault() {
      const authorization = load('packages/operator-core/lib/personal-vault/authorization.ts') as
        Pick<typeof import('../personal-vault/authorization'), 'authorizePersonalAccess'>;
      const ambient = load('packages/operator-core/lib/personal-vault/ambient.ts') as
        Pick<typeof import('../personal-vault/ambient'), 'resolvePersonalAmbientToolContext' | 'buildPersonalAmbientContextBlock'>;
      const disclosures = load('packages/operator-core/lib/personal-vault/disclosure-ledger.ts') as
        Pick<typeof import('../personal-vault/disclosure-ledger'), 'discloseDocuments' | 'assertDisclosurePermits'>;
      const transcripts = load('packages/operator-core/lib/personal-vault/transcript-exclusion.ts') as
        Pick<typeof import('../personal-vault/transcript-exclusion'), 'loadTranscriptExclusion'>;
      return { ...authorization, ...ambient, ...disclosures, ...transcripts };
    },
  };
}

/** Load each revision's canonical preflight, including its own generic-library
 * gitlinks. Host policy/argument ports still have to be supplied independently;
 * this adapter establishes the dispatcher source, not full D-043 acceptance.
 * Unknown imports and mismatched installed dependencies fail closed.
 */
export async function loadIdopP001DispatchPermissionReader(options: {
  root: string; revision: string; includeIdentityReplay?: boolean;
}) {
  const current = options.revision === 'working-tree';
  if (!current && !/^[a-f0-9]{40}$/.test(options.revision)) {
    throw new Error('IDOP dispatch comparison requires an exact source revision');
  }
  const git = (repo: string, args: string[]) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const packages: Record<string, string> = Object.fromEntries(
    ['tooldef', 'rules', 'module-singleton', 'result-encoding', 'chat-protocol']
      .map(name => [`@papercusp/${name}`, `libs/generic/${name}`]),
  );
  if (options.includeIdentityReplay) {
    packages['@papercusp/orchestrator'] = 'libs/papercusp/packages/orchestrator';
    packages['@papercusp/harness'] = 'libs/papercusp/packages/harness';
  }
  const locations = new Map<string, { repo: string; revision: string; prefix: string }>();
  const sources = new Map<string, { path: string; revision: string; sha256: string }>();
  const sourceTexts = new Map<string, string>();
  const read = (path: string): string => {
    const cached = sourceTexts.get(path);
    if (cached !== undefined) return cached;
    const directory = Object.values(packages).find(prefix => path.startsWith(prefix + '/')) ??
      (options.includeIdentityReplay && path.startsWith('packages/operator-core/lib/') ? 'packages/operator-core' : undefined);
    if (!directory) throw new Error(`IDOP dispatch comparison unpinned source: ${path}`);
    let location = locations.get(directory);
    if (!location) {
      const pin = directory.startsWith('libs/papercusp/') ? 'libs/papercusp' : directory;
      const tree = current ? [] : git(options.root, ['ls-tree', options.revision, pin]).trim().split(/\s+/);
      const nested = tree[0] === '160000';
      if (!current && !/^[a-f0-9]{40}$/.test(tree[2] ?? '')) throw new Error(`IDOP missing source pin: ${directory}`);
      location = { repo: nested ? join(options.root, pin) : options.root,
        revision: current ? 'working-tree' : nested ? tree[2] : options.revision,
        prefix: nested ? pin + '/' : '' };
      locations.set(directory, location);
    }
    const text = current ? readFileSync(join(options.root, path), 'utf8') :
      git(location.repo, ['show', `${location.revision}:${path.slice(location.prefix.length)}`]);
    sources.set(path, { path, revision: location.revision, sha256: sha256(text) });
    sourceTexts.set(path, text);
    return text;
  };
  const lockText = current ? readFileSync(join(options.root, 'package-lock.json'), 'utf8') :
    git(options.root, ['show', `${options.revision}:package-lock.json`]);
  const locked = JSON.parse(lockText).packages as Record<string, { version?: string }>;
  const installedLock = JSON.parse(readFileSync(join(options.root, 'package-lock.json'), 'utf8')).packages;
  const external = new Map<string, { name: string; version: string; lockSha256: string }>();
  const allowedImports = new Set<string>();
  const require = createRequire(join(options.root, 'package.json'));
  const bundle = await build({
    stdin: { contents: "export { preflightDispatchStack } from '@papercusp/tooldef/dispatch-stack';\n" +
      "export { sameKernelRevision } from '@papercusp/tooldef/kernel-enforcement';\n" +
      (options.includeIdentityReplay ?
        "export { replayAgentSpecification } from '@papercusp/orchestrator/blueprint/composition-compiler';" : ''),
      sourcefile: 'idop-preflight-entry.ts', resolveDir: options.root },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent',
    plugins: [{ name: 'idop-pinned-source', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path.startsWith('node:')) {
          allowedImports.add(args.path);
          return { path: args.path, external: true };
        }
        if (/^(zod|zod-to-json-schema|mingo|yaml|@toon-format\/toon)(\/|$)/.test(args.path)) {
          const name = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0];
          const key = `node_modules/${name}`;
          const installed = JSON.parse(readFileSync(join(options.root, key, 'package.json'), 'utf8'));
          if (!locked[key]?.version || installed.version !== locked[key].version ||
              JSON.stringify(locked[key]) !== JSON.stringify(installedLock[key])) {
            throw new Error(`IDOP dispatch comparison dependency mismatch: ${name}`);
          }
          external.set(name, { name, version: installed.version, lockSha256: sha256(JSON.stringify(locked[key])) });
          allowedImports.add(args.path);
          return { path: args.path, external: true };
        }
        let path: string;
        if (args.path.startsWith('.')) {
          path = relative(options.root, resolve(options.root, dirname(args.importer), args.path));
        } else {
          const name = Object.keys(packages).find(name => args.path === name || args.path.startsWith(name + '/'));
          if (!name) throw new Error(`IDOP dispatch comparison unpinned import: ${args.path}`);
          path = `${packages[name]}/${name === '@papercusp/harness' ? '' : 'src/'}${args.path === name ? 'index' : args.path.slice(name.length + 1)}`;
        }
        const candidates = /\.[cm]?[jt]s$/.test(path) ? [path.replace(/\.js$/, '.ts')] : [`${path}.ts`, `${path}/index.ts`];
        for (const candidate of candidates) {
          try {
            read(candidate);
            // The saved-artifact replay export promises no file/registry
            // reads. Drop UNUSED orchestrator imports (the loader computes
            // mutable harness roots at module initialization), while keeping
            // every declaration actually used by replay and its source hash.
            return { path: candidate, namespace: 'idop-source',
              ...(options.includeIdentityReplay && candidate.startsWith('libs/papercusp/packages/orchestrator/')
                ? { sideEffects: false } : {}) };
          }
          catch (error) {
            if (candidate === candidates.at(-1)) throw error;
          }
        }
        throw new Error(`IDOP unreadable dispatch import: ${args.path}`);
      });
      builder.onLoad({ filter: /.*/, namespace: 'idop-source' }, args => {
        let contents = read(args.path);
        const entry = args.path.endsWith('/blueprint/composition-compiler.ts') ? ['replayAgentSpecification'] :
          args.path.endsWith('/blueprint/loader.ts') ? ['layerContentHash', 'blueprintHash'] : null;
        if (options.includeIdentityReplay && entry) {
          const { file, declarations, selected } = idopSourceDeclarations(args.path, contents, entry, {}, true);
          contents = file.statements.filter(ts.isImportDeclaration).map(s => s.getText(file)).join('\n') + '\n' +
            selected.map(name => declarations.get(name)![0].replace(/^export\s+/, '')).join('\n') +
            `\nexport { ${entry.join(', ')} };`;
          // Function declarations may already export themselves. A single
          // trailing export also handles selected const declarations.
        }
        return { contents, loader: 'ts' };
      });
    } }],
  });
  const module = { exports: {} as Record<string, unknown> };
  const noTimer = () => { throw new Error('IDOP preflight attempted to own a timer'); };
  // A canonical leaf may catch a failed read and use a fallback, or a schema
  // may replace it with a generic validation error. Refuse at OUR boundary
  // even then: neither outcome proves replay of captured authority.
  const uncapturedReads = new Set<string>();
  const assertCaptured = () => {
    if (uncapturedReads.size) {
      const methods = [...uncapturedReads].sort().join(', ');
      uncapturedReads.clear();
      throw new Error(`IDOP replay attempted an uncaptured filesystem read: ${methods}`);
    }
  };
  const captured = <T,>(read: () => T): T => {
    try { return read(); } finally { assertCaptured(); }
  };
  const sandbox = {
    module, exports: module.exports,
    require: (name: string) => {
      if (!allowedImports.has(name)) throw new Error(`IDOP dispatch comparison unpinned runtime import: ${name}`);
      if (name === 'node:fs' || name === 'node:fs/promises') return new Proxy({}, { get: (_target, key) => () => {
        uncapturedReads.add(`${name}.${String(key)}`);
        throw new Error(`IDOP replay attempted an uncaptured filesystem read: ${String(key)}`);
      } });
      return require(name);
    },
    AbortController, AbortSignal, TextEncoder, TextDecoder, URL, structuredClone, Buffer,
    process: { env: Object.freeze({}) }, ...(options.includeIdentityReplay ? { globalThis: {} } : {}),
    setTimeout: noTimer, setInterval: noTimer,
    clearTimeout: noTimer, clearInterval: noTimer,
  };
  if (options.includeIdentityReplay) {
    // The pinned compiler rejects non-plain JSON objects by prototype. Its
    // lock-verified external Zod returns host-realm objects, so a different VM
    // realm falsely refuses authentic artifacts. Execute with the SAME realm
    // and explicit lexical host bindings; keep require/FS/timers/process and
    // the singleton global isolated. Do not JSON-roundtrip away invalid input.
    captured(() => compileFunction(bundle.outputFiles[0].text, Object.keys(sandbox), {
      filename: 'idop-pinned-replay.cjs',
    })(...Object.values(sandbox)));
  } else captured(() => runInNewContext(bundle.outputFiles[0].text, sandbox,
    { filename: 'idop-pinned-preflight.cjs', timeout: 10_000 }));
  if (typeof module.exports.preflightDispatchStack !== 'function') throw new Error('IDOP missing canonical dispatch preflight');
  if (typeof module.exports.sameKernelRevision !== 'function') throw new Error('IDOP missing canonical kernel revision reader');
  const preflight = module.exports.preflightDispatchStack as typeof preflightDispatchStack;
  const compareRevisions = module.exports.sameKernelRevision as typeof sameKernelRevision;
  return { revision: options.revision, packageLockSha256: sha256(lockText),
    sources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)),
    externalDependencies: [...external.values()].sort((a, b) => a.name.localeCompare(b.name)),
    sameKernelRevision: (...args: Parameters<typeof sameKernelRevision>) => compareRevisions(...args),
    replayAgentSpecification: typeof module.exports.replayAgentSpecification === 'function' ?
      (...args: Parameters<typeof replayAgentSpecification>) => captured(() =>
        (module.exports.replayAgentSpecification as typeof replayAgentSpecification)(...args)) : undefined,
    evaluate: async (...args: Parameters<typeof preflightDispatchStack>) => {
      try {
        return JSON.parse(JSON.stringify(await preflight(...args))) as Awaited<ReturnType<typeof preflightDispatchStack>>;
      } finally { assertCaptured(); }
    },
  };
}

/** Current BUILTIN + local pot source population, not a live-wearer or plugin
 * census. Keep the source boundary explicit until those independent inputs are
 * joined by the full comparison runner. Malformed declarations cannot disappear
 * through the frozen baseline builder's historical best-effort scan. */
export function readIdopP001CurrentBuiltinPopulation(root: string) {
  const reader = loadIdopP001RolePermissionReader({ root, revision: 'working-tree', testingFullAccess: 'off' });
  const roles = new Set(reader.roles);
  const sources: Array<{ path: string; sha256: string }> = [...reader.sources];
  const identities: Array<{ id: string; path: string; slots: string[] }> = [];
  const directoriesWithoutBlueprint: string[] = [];
  const document = (path: string, yaml: boolean): Record<string, unknown> => {
    const text = readFileSync(join(root, path), 'utf8');
    sources.push({ path, sha256: sha256(text) });
    const raw: unknown = yaml ? parseYaml(text) : JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid current population document: ${path}`);
    return raw as Record<string, unknown>;
  };
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value) throw new Error('Invalid current population id');
    return value;
  };
  const base = 'libs/papercusp/packages/harness/blueprints';
  for (const entry of readdirSync(join(root, base), { withFileTypes: true }).filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${base}/${entry.name}/blueprint.yaml`;
    if (!existsSync(join(root, path))) {
      directoriesWithoutBlueprint.push(`${base}/${entry.name}`);
      continue;
    }
    const raw = document(path, true);
    if (raw.slots === undefined) continue;
    if (!Array.isArray(raw.slots)) throw new Error(`Invalid current identity slots: ${path}`);
    const slots = raw.slots.map(slot => id(slot && typeof slot === 'object' ? (slot as { slot?: unknown }).slot : null));
    identities.push({ id: id(raw.id), path, slots });
  }
  if (new Set(identities.map(identity => identity.id)).size !== identities.length) throw new Error('Duplicate current identity id');
  const prompts = `${base}/base/prompts`;
  for (const name of readdirSync(join(root, prompts)).filter(name => name.endsWith('.role.json')).sort()) {
    // role-registry.ts/readBuiltinRoles requires BOTH the filename key and
    // matching declaration, valid output and an existing prompt. Refuse bad
    // declarations rather than counting a role the running registry discards.
    const raw = document(`${prompts}/${name}`, false);
    const role = name.slice(0, -'.role.json'.length);
    const output = raw.output as { kind?: unknown; featureKind?: unknown } | null;
    if (!/^[a-z][a-z0-9-]*$/.test(role) || raw.id !== role ||
        typeof raw.whenUseful !== 'string' || !raw.whenUseful || !output ||
        (output.kind !== 'spec' && (output.kind !== 'features' || typeof output.featureKind !== 'string' ||
          !/^[a-z][a-z0-9-]*$/.test(output.featureKind)))) throw new Error(`Invalid current role manifest: ${name}`);
    const promptPath = `${prompts}/${role}.md`;
    sources.push({ path: promptPath, sha256: sha256(readFileSync(join(root, promptPath))) });
    roles.add(role);
  }
  const potPath = '.papercusp/blueprint.yaml';
  if (existsSync(join(root, potPath))) {
    const pot = document(potPath, true);
    const fleet = pot.fleet as { workerRoles?: unknown } | undefined;
    for (const declarations of [pot.roles, fleet?.workerRoles]) {
      if (declarations === undefined) continue;
      if (!Array.isArray(declarations)) throw new Error('Invalid current pot role declaration');
      for (const role of declarations) roles.add(id(role && typeof role === 'object' ? (role as { id?: unknown }).id : null));
    }
  }
  return { scope: 'builtin-and-local-pot-source' as const, liveWearersIncluded: false as const,
    directoriesWithoutBlueprint,
    roles: [...roles].sort(), identities: identities.sort((a, b) => a.id.localeCompare(b.id)),
    sources: sources.sort((a, b) => a.path.localeCompare(b.path)) };
}

type CurrentLibraryDependencies = {
  sources: () => BlueprintSourceLocation[];
  page: typeof listIdentitySources;
  roles: (harness: string) => RoleManifest[];
};

/** Enumerate the actual selected local/installed/builtin library and enabled
 * plugin role registry. Source candidates are independently classified before
 * paging: an empty identity page may contain ordinary blueprints, and a missing
 * identity must not become an apparently complete census. Selected identities
 * refused by the canonical reader remain explicit negative inputs: they do not
 * become launchable, disappear, or reveal a lower-precedence source. This is a
 * SOURCE population; neither launch eligibility nor a library entry proves wear.
 */
export async function readIdopP001CurrentLibraryPopulation(
  options: { root: string; harnessSlug: string },
  dependencies?: CurrentLibraryDependencies,
) {
  if (!options.harnessSlug.trim() || options.harnessSlug !== options.harnessSlug.trim()) {
    throw new Error('IDOP current library requires an explicit harness');
  }
  const deps = dependencies ?? await (async () => {
    const [library, catalog, registry] = await Promise.all([
      import('./source'), import('../blueprint/installed-blueprints'), import('../role-registry'),
    ]);
    return { sources: () => catalog.availableBlueprintSources({ localDirs: library.localDirs(options.root) }),
      page: library.listIdentitySources, roles: registry.listRoles };
  })();
  const snapshot = () => {
    const locations = deps.sources().slice().sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(locations.map(source => source.id)).size !== locations.length) {
      throw new Error('IDOP current library has duplicate source ids');
    }
    return locations.map(source => {
      if (!source.id.trim() || source.id !== source.id.trim() ||
          !['local', 'installed', 'builtin'].includes(source.tier) || !source.file.trim()) {
        throw new Error('IDOP current library has an invalid source');
      }
      const bytes = readFileSync(source.file);
      let parsed: ReturnType<typeof parseBlueprintSourceDocument>;
      try { parsed = parseBlueprintSourceDocument(parseYaml(bytes.toString('utf8'))); }
      catch (cause) { throw new Error(`IDOP current library unreadable source ${source.id}: ${source.file}`, { cause }); }
      return { ...source, sha256: sha256(bytes), kind: parsed.kind,
        sourceId: parsed.document.id,
        slots: parsed.kind === 'identity' ? parsed.document.slots.map(slot => slot.slot).sort() : [] };
    });
  };
  const sources = snapshot();
  const registry = () => {
    const roles = structuredClone(deps.roles(options.harnessSlug)).sort((a, b) => a.id.localeCompare(b.id));
    if (roles.some(role => !role.id.trim() || role.id !== role.id.trim()) ||
        new Set(roles.map(role => role.id)).size !== roles.length) {
      throw new Error('IDOP current library has invalid or duplicate runtime roles');
    }
    return roles;
  };
  const roles = registry();
  const identities: Awaited<ReturnType<typeof listIdentitySources>>['identities'] = [];
  const unreadable: Awaited<ReturnType<typeof listIdentitySources>>['unreadable'] = [];
  const pages: Array<{ after: string | null; scanned: number; ids: string[];
    unreadableIds: string[]; nextAfter: string | null }> = [];
  // One empty read is still needed to verify that an empty source snapshot is
  // also empty on the independent library path.
  for (let offset = 0; offset === 0 || offset < sources.length; offset += 100) {
    const candidates = sources.slice(offset, offset + 100);
    const after = offset ? sources[offset - 1].id : undefined;
    const expectedNext = offset + 100 < sources.length ? candidates.at(-1)!.id : null;
    const page = await deps.page({ repoDir: options.root, after, limit: 100 });
    if (!page.ok || page.scanned !== candidates.length ||
        page.count !== page.identities.length || page.nextAfter !== expectedNext) {
      throw new Error(`IDOP current library incomplete or unreadable page after ${after ?? '<start>'}`);
    }
    const refused = new Set<string>();
    for (const refusal of page.unreadable) {
      const source = candidates.find(candidate => candidate.id === refusal.id);
      if (!source || source.kind !== 'identity' || refused.has(refusal.id) ||
          refusal.tier !== source.tier || refusal.sourcePath !== source.file ||
          typeof refusal.error !== 'string' || !refusal.error.trim() ||
          page.identities.some(identity => identity.id === refusal.id)) {
        throw new Error(`IDOP current library incomplete or unreadable page after ${after ?? '<start>'}`);
      }
      refused.add(refusal.id);
    }
    const expected = candidates.filter(source => source.kind === 'identity' && !refused.has(source.id));
    if (page.identities.length !== expected.length || page.identities.some((identity, index) => {
      const source = expected[index];
      return !source || identity.id !== source.id || identity.sourceId !== source.sourceId ||
        identity.tier !== source.tier || identity.sourcePath !== source.file ||
        !/^[a-f0-9]{64}$/.test(identity.sourceRevision) ||
        comparisonJson(identity.slots.map(slot => slot.slot).sort()) !== comparisonJson(source.slots);
    })) throw new Error('IDOP current library omitted or substituted an identity');
    identities.push(...page.identities);
    unreadable.push(...page.unreadable);
    pages.push({ after: after ?? null, scanned: page.scanned,
      ids: page.identities.map(identity => identity.id), unreadableIds: [...refused], nextAfter: page.nextAfter });
  }
  if (comparisonJson(sources) !== comparisonJson(snapshot()) ||
      comparisonJson(JSON.parse(JSON.stringify(roles))) !== comparisonJson(JSON.parse(JSON.stringify(registry())))) {
    throw new Error('IDOP current library changed during enumeration');
  }
  return { scope: 'selected-library-and-enabled-plugin-role-source' as const,
    liveWearersIncluded: false as const, harnessSlug: options.harnessSlug,
    identities, unreadable, roles, pages, sources };
}

/** Installed manifest declarations, independently checked against the loader's
 * complete discovery outcomes. Metadata-only loading never imports an entry or
 * runs dynamic discovery. This is source evidence, not a live registry census;
 * dynamic tools and host registration remain separate comparison inputs. */
export async function readIdopP001InstalledPluginToolPopulation(
  options: { root: string; harnessSlug: string },
  dependencies?: { discover: (options: LoaderOptions) => Promise<{
    loaded: LoadedPlugin[]; discovery: PluginDiscoveryInventory;
    errors: Array<{ error: string; path: string }>;
  }> },
) {
  if (!options.harnessSlug.trim() || options.harnessSlug !== options.harnessSlug.trim() || !isAbsolute(options.root)) {
    throw new Error('IDOP installed plugin population requires an absolute root and explicit harness');
  }
  const discover = dependencies?.discover ?? (await import('@papercusp/plugin-loader')).loadPlugins;
  const result = await discover({ projectDir: join(options.root, 'libs/papercusp'),
    harnessSlugs: [options.harnessSlug], metadataOnly: true });
  const discovery = structuredClone(result.discovery);
  if (!Array.isArray(discovery?.roots) || !Array.isArray(discovery.candidates) || !Array.isArray(discovery.unavailable)) {
    throw new Error('IDOP installed plugin discovery inventory is unavailable');
  }
  const key = (row: { path: string; source: string }) => JSON.stringify([row.path, row.source]);
  if (new Set(discovery.candidates.map(key)).size !== discovery.candidates.length) {
    throw new Error('IDOP installed plugin discovery duplicated a candidate');
  }
  const selected = discovery.candidates.filter(row => row.status === 'loaded');
  if (selected.length !== result.loaded.length || new Set(selected.map(row => row.pluginName)).size !== selected.length) {
    throw new Error('IDOP installed plugin discovery omitted or duplicated a selected installation');
  }
  const same = (a: unknown, b: unknown) => comparisonJson(idopAuthorityData(a)) === comparisonJson(idopAuthorityData(b));
  const sources: Array<{ path: string; sha256: string }> = [];
  const plugins = result.loaded.map(plugin => {
    const candidate = selected.find(row => key(row) === key(plugin));
    if (!candidate || candidate.pluginName !== plugin.plugin.name || !candidate.manifest ||
        candidate.manifest.name !== plugin.plugin.name || candidate.manifest.version !== plugin.plugin.version ||
        !same(candidate.manifest.tools, plugin.toolDefinitions) ||
        !same(candidate.manifest.capabilities, plugin.plugin.capabilities)) {
      throw new Error('IDOP installed plugin discovery omitted or substituted selected declarations');
    }
    const path = join(plugin.path, 'papercusp.json');
    const bytes = readFileSync(path);
    const manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (manifest.name !== plugin.plugin.name || manifest.version !== plugin.plugin.version ||
        !same(manifest.tools ?? [], plugin.toolDefinitions) ||
        !same(manifest.capabilities ?? [], plugin.plugin.capabilities)) {
      throw new Error('IDOP installed plugin manifest changed after discovery');
    }
    sources.push({ path, sha256: sha256(bytes) });
    const declarations = structuredClone(plugin.toolDefinitions ?? []);
    if (new Set(declarations.map(tool => tool.name)).size !== declarations.length || declarations.some(tool =>
      typeof tool.name !== 'string' || !tool.name.trim() || tool.name !== tool.name.trim() ||
      !Array.isArray(tool.capabilities) || tool.capabilities.some(cap => typeof cap !== 'string' || !cap.trim()))) {
      throw new Error('IDOP installed plugin has malformed or duplicate tool declarations');
    }
    return { name: plugin.plugin.name, version: plugin.plugin.version, path: plugin.path, source: plugin.source,
      manifestSha256: sha256(bytes), declarations };
  });
  const names = plugins.flatMap(plugin => plugin.declarations.map(tool =>
    tool.expose?.mcp?.name ?? `${plugin.name.replace(/^@[^/]+\//, '')}.${tool.name}`));
  if (new Set(names).size !== names.length || names.some(name => typeof name !== 'string' || !name.trim() || name !== name.trim())) {
    throw new Error('IDOP installed plugin has conflicting or malformed MCP identities');
  }
  for (const source of sources) if (sha256(readFileSync(source.path)) !== source.sha256) {
    throw new Error('IDOP installed plugin manifest changed during enumeration');
  }
  const inventory = { scope: 'installed-plugin-manifest-tool-source' as const, harnessSlug: options.harnessSlug,
    runtimeRegistrationMeasured: false as const, dynamicToolsMeasured: false as const,
    plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)), discovery,
    errors: structuredClone(result.errors), sources: sources.sort((a, b) => a.path.localeCompare(b.path)) };
  return { ...inventory, sha256: sha256(comparisonJson(idopAuthorityData(inventory))) };
}

type AppliedStackRevision = { specificationRevision: string; stateRevision: string };
type AppliedStackDependencies = {
  anchors: () => Promise<Array<{ ownerId: string; applied: unknown }>>;
  record: (ownerId: string, workspaceId: string, revision: AppliedStackRevision) => Promise<unknown>;
};

/** Snapshot every persisted applied anchor in this workspace, including parked
 * or ended wearers. Use the SAME gate-selected launch-record/receipt resolver as
 * execution: a newer desired artifact must never replace the applied one, and a
 * control-only transition may still resolve the current specification. A stale
 * applied receipt remains a canonical refusal input, with its exact launch
 * record; it must never disappear or be replaced by the desired artifact. No
 * liveness claim or selected-library join is implied by this source adapter.
 * Digest-only retention runs the SAME receipt resolution and hashes the SAME
 * complete inputs, but releases their payloads after each member. The joined
 * inventory needs only those digests and layer pins; retaining every compiled
 * prompt and launch record would make its memory grow with their total size.
 * This mode is inventory evidence, not a saved permission-replay snapshot.
 */
export async function readIdopP001AppliedStackPopulation(
  workspaceId: string,
  dependencies?: AppliedStackDependencies,
  options: { payloads: 'retained' | 'digests-only'; sql?: import('postgres').Sql } = { payloads: 'retained' },
) {
  if (!workspaceId.trim() || workspaceId !== workspaceId.trim()) throw new Error('IDOP applied stacks require a workspace');
  if (options.payloads !== 'retained' && options.payloads !== 'digests-only') {
    throw new Error('IDOP applied stacks require an explicit payload retention mode');
  }
  const receiptSource = loadIdopP001RolePermissionReader({ root,
    revision: 'working-tree', testingFullAccess: 'off' });
  const { appliedOrCurrentIdentityArtifact, selectAppliedReceipt, resolveIdentityArtifact, identityWearerRole } =
    receiptSource.createAppliedReceiptReader();
  const enumerate = async (deps: AppliedStackDependencies) => {
    const snapshot = async () => {
      const rows = await deps.anchors();
      if (new Set(rows.map(row => row.ownerId)).size !== rows.length) throw new Error('IDOP duplicate applied owner');
      return rows.map(row => {
        const revision = row.applied as Partial<AppliedStackRevision> | null;
        if (!row.ownerId.trim() || row.ownerId !== row.ownerId.trim() ||
            typeof revision?.specificationRevision !== 'string' || !/^[a-f0-9]{64}$/.test(revision.specificationRevision) ||
            typeof revision.stateRevision !== 'string' || !revision.stateRevision.trim()) {
          throw new Error(`IDOP malformed applied anchor: ${row.ownerId}`);
        }
        return { ownerId: row.ownerId, applied: { specificationRevision: revision.specificationRevision,
          stateRevision: revision.stateRevision } };
      }).sort((a, b) => a.ownerId.localeCompare(b.ownerId));
    };
    const anchors = await snapshot();
    const stacks = [];
    const refused = [];
    for (const anchor of anchors) {
      const raw = await deps.record(anchor.ownerId, workspaceId, anchor.applied);
      const launchRecord = raw ?? null;
      const recordSha256 = sha256(JSON.stringify(launchRecord));
      const resolution = resolveIdentityArtifact(
        raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}, anchor.applied);
      if (resolution.kind === 'stale-artifact') {
        refused.push({ ...anchor, resolution, recordSha256,
          ...(options.payloads === 'retained' ? { launchRecord } : {}) });
        continue;
      }
      const artifact = appliedOrCurrentIdentityArtifact(raw, anchor.applied);
      if (!artifact) throw new Error(`IDOP applied artifact unreadable: ${anchor.ownerId}`);
      const receipt = selectAppliedReceipt(raw, anchor.applied) ?? raw;
      const stack = receipt && typeof receipt === 'object' ? (receipt as { stack?: unknown }).stack : undefined;
      if (stack !== undefined && (!Array.isArray(stack) || stack.some(ref => typeof ref !== 'string' || !ref.trim()))) {
        throw new Error(`IDOP malformed applied stack: ${anchor.ownerId}`);
      }
      stacks.push({ ...anchor, role: identityWearerRole(raw), recordSha256,
        explicitStack: (stack ?? []) as string[],
        artifactSha256: sha256(JSON.stringify(artifact)),
        layers: artifact.inputs.filter(input => input.kind === 'blueprint-layer')
          .map(({ ref, revision, contentHash, sourceKind }) => ({ ref, revision, contentHash, sourceKind })),
        ...(options.payloads === 'retained' ? { launchRecord, artifact } : {}) });
    }
    if (comparisonJson(anchors) !== comparisonJson(await snapshot())) {
      throw new Error('IDOP applied anchors changed during enumeration');
    }
    return { scope: 'workspace-persisted-applied-anchors' as const, workspaceId,
      payloads: options.payloads,
      receiptSources: receiptSource.sources, receiptFunctions: receiptSource.hostFunctions,
      includesInactiveAnchors: true as const, livenessMeasured: false as const, stacks, refused };
  };
  if (dependencies) return enumerate(dependencies);
  const { narrowedLaunchSpecToAppliedPairSql } = await import('../capability-envelope/identity-receipt-narrowing');
  // A private test connection exercises these exact queries without importing
  // the live DB/bootstrap barrel or replacing its growing export surface.
  const sql = options.sql ?? (await import('@papercusp/db-org')).getOrgPg().sql;
  // One MVCC snapshot binds anchors and latest launch rows, including while
  // other sessions activate. Batch BEFORE reading bodies and reuse the gate's
  // exact per-row history narrowing; never retrieve every historical receipt.
  return sql.begin('isolation level repeatable read read only', async transaction => {
    const tx = transaction as unknown as typeof sql;
    let rows: Array<{ ownerId: string; applied: unknown }> | undefined;
    const anchors = async () => {
      rows ??= await tx<Array<{ ownerId: string; applied: unknown }>>`
        SELECT owner_id AS "ownerId", control_state->'activation'->'applied' AS applied
          FROM harness_shared.session_briefs
         WHERE workspace_id = ${workspaceId}
           AND control_state->'activation'->'applied' IS NOT NULL
           AND control_state->'activation'->'applied' <> 'null'::jsonb
         ORDER BY owner_id`;
      return rows;
    };
    const records = new Map<string, unknown>();
    let indexes: Map<string, number> | undefined;
    return enumerate({ anchors, record: async (ownerId, scope) => {
      if (scope !== workspaceId) throw new Error('IDOP applied record workspace mismatch');
      if (!records.has(ownerId)) {
        const population = await anchors();
        indexes ??= new Map(population.map((row, index) => [row.ownerId, index]));
        const index = indexes.get(ownerId);
        if (index === undefined) throw new Error('IDOP applied record owner omitted');
        const start = Math.floor(index / 100) * 100;
        const owners = population.slice(start, start + 100).map(row => row.ownerId);
        const page = await tx<Array<{ ownerId: string; launchRecord: unknown }>>`
          SELECT n.owner_id AS "ownerId", ${narrowedLaunchSpecToAppliedPairSql(tx)} AS "launchRecord"
            FROM (
              SELECT b.owner_id, b.control_state->'activation'->'applied' AS applied_pair, s.launch_spec
                FROM harness_shared.session_briefs b
                LEFT JOIN LATERAL (
                  SELECT a.launch_spec FROM harness_shared.adv_sessions a
                   WHERE a.workspace_id = b.workspace_id AND a.coord_owner_id = b.owner_id
                   ORDER BY a.id DESC LIMIT 1
                ) s ON true
               WHERE b.workspace_id = ${workspaceId} AND b.owner_id = ANY(${owners}::text[])
            ) n`;
        if (page.length !== owners.length || new Set(page.map(row => row.ownerId)).size !== owners.length ||
            page.some(row => !owners.includes(row.ownerId))) throw new Error('IDOP applied record page incomplete');
        records.clear();
        for (const row of page) records.set(row.ownerId, row.launchRecord);
      }
      return records.get(ownerId);
    } });
  });
}

/** Join independently read source domains BEFORE enumerating executable cases.
 * A selected-library refusal cannot be hidden by a builtin with the same id;
 * persisted anchors retain readable/refused partitions and inactive wearers.
 * This inventory proves no current liveness, host authority or policy outcome.
 * The comparison runner must separately enumerate cases against population. */
export function joinIdopP001ComparisonPopulation(options: {
  builtin: ReturnType<typeof readIdopP001CurrentBuiltinPopulation>;
  library: Awaited<ReturnType<typeof readIdopP001CurrentLibraryPopulation>>;
  applied: Awaited<ReturnType<typeof readIdopP001AppliedStackPopulation>>;
}) {
  const { builtin, library, applied } = options;
  if (builtin.scope !== 'builtin-and-local-pot-source' || builtin.liveWearersIncluded !== false ||
      library.scope !== 'selected-library-and-enabled-plugin-role-source' || library.liveWearersIncluded !== false ||
      !library.harnessSlug.trim() || applied.scope !== 'workspace-persisted-applied-anchors' ||
      !applied.workspaceId.trim() || applied.includesInactiveAnchors !== true || applied.livenessMeasured !== false) {
    throw new Error('IDOP comparison population requires explicit source scopes without liveness claims');
  }
  type Member = { id: string; kind: 'role' | 'identity' | 'stack'; sources: Array<{
    origin: 'builtin' | 'library' | 'applied'; status: 'declared' | 'readable' | 'refused';
    sha256: string; data: ComparisonJson;
  }> };
  const members = new Map<string, Member>();
  const add = (kind: Member['kind'], name: string, origin: Member['sources'][number]['origin'],
    status: Member['sources'][number]['status'], value: unknown) => {
    if (!name?.trim() || name !== name.trim()) throw new Error('IDOP comparison population has a blank or malformed id');
    const id = `${kind}:${name}`;
    const member = members.get(id) ?? { id, kind, sources: [] };
    if (member.sources.some(source => source.origin === origin)) throw new Error('IDOP comparison population has duplicate domain members');
    const data = idopAuthorityData(value);
    member.sources.push({ origin, status, sha256: sha256(comparisonJson(data)), data });
    members.set(id, member);
  };
  for (const role of builtin.roles) add('role', role, 'builtin', 'declared', { role, sources: builtin.sources });
  for (const role of library.roles) add('role', role.id, 'library', 'declared', role);
  for (const identity of builtin.identities) {
    const source = builtin.sources.filter(source => source.path === identity.path);
    if (source.length !== 1) throw new Error('IDOP comparison builtin identity has no unique source evidence');
    add('identity', identity.id, 'builtin', 'declared', { ...identity, source: source[0] });
  }
  const candidates = new Map(library.sources.filter(source => source.kind === 'identity').map(source => [source.id, source]));
  if (candidates.size !== library.sources.filter(source => source.kind === 'identity').length) {
    throw new Error('IDOP comparison library has duplicate identity sources');
  }
  const selected = new Set<string>();
  for (const identity of [...library.identities, ...library.unreadable]) {
    const source = candidates.get(identity.id);
    if (!source || selected.has(identity.id) || source.file !== identity.sourcePath || source.tier !== identity.tier ||
        'sourceId' in identity && (identity.sourceId !== source.sourceId ||
          comparisonJson(identity.slots.map(slot => slot.slot).sort()) !== comparisonJson(source.slots))) {
      throw new Error('IDOP comparison library omitted or substituted an identity');
    }
    const refused = 'error' in identity;
    if (refused && (typeof identity.error !== 'string' || !identity.error.trim())) {
      throw new Error('IDOP comparison library has a blank refusal');
    }
    selected.add(identity.id);
    add('identity', identity.id, 'library', refused ? 'refused' : 'readable', { identity, source });
  }
  if (selected.size !== candidates.size) throw new Error('IDOP comparison library omitted an identity');
  for (const row of applied.stacks) add('stack', row.ownerId, 'applied', 'readable', {
    applied: row.applied, role: row.role, recordSha256: row.recordSha256, artifactSha256: row.artifactSha256,
    explicitStack: row.explicitStack, layers: row.layers,
  });
  for (const row of applied.refused) add('stack', row.ownerId, 'applied', 'refused', {
    applied: row.applied, recordSha256: row.recordSha256,
    // The canonical resolver executes in its pinned VM realm. Project its
    // fixed scalar contract; do not admit arbitrary foreign prototypes into
    // the general authority codec or serialize away unsupported values.
    resolution: { kind: row.resolution.kind, reason: row.resolution.reason },
  });
  const rows = [...members.values()].sort((a, b) => a.id.localeCompare(b.id));
  const inventory = { scope: 'independent-source-and-persisted-anchor-comparison-domain' as const,
    workspaceId: applied.workspaceId, harnessSlug: library.harnessSlug, livenessMeasured: false as const,
    includesInactiveAnchors: true as const, population: rows.map(row => row.id), members: rows };
  return { ...inventory, sha256: sha256(comparisonJson(inventory as unknown as ComparisonJson)) };
}

/** Finalize the existing manifest/stack/refused gzip evidence without loading
 * the archive or a full launch record into one Buffer/string. Reuses the same
 * streaming parser/selectors as push-snapshot.ts. Full JSON syntax, gzip CRC and
 * EOF are checked even for unselected private payloads; only bounded population
 * metadata escapes. This verifies an archive, not current liveness or policy. */
export async function inspectIdopP001AppliedStackArchive(options: {
  path: string;
  workspaceId: string;
  sourceSha256: string;
  expectedTotal: number;
  expectedOutputSha256?: string;
  onProgress?: (rows: number, compressedBytes: number) => void;
}) {
  if (!options.workspaceId.trim() || !/^[a-f0-9]{64}$/.test(options.sourceSha256) ||
      !Number.isSafeInteger(options.expectedTotal) || options.expectedTotal < 0) throw new Error('IDOP archive requires independent source and population expectations');
  const digest = createHash('sha256');
  let compressedBytes = 0;
  let depth = 0;
  let root = -1;
  let selected = '';
  let selectedRoot = -1;
  let selectedString = '';
  const fields = new Set(['kind', 'scope', 'workspaceId', 'includesInactiveAnchors', 'livenessMeasured',
    'source', 'sourceSha256', 'startedAt', 'completedAt', 'ownerId', 'recordSha256', 'artifactSha256',
    'applied.specificationRevision', 'applied.stateRevision', 'resolution.kind', 'resolution.reason']);
  const gunzip = createGunzip();
  gunzip.setEncoding('utf8');
  const input = chain([createReadStream(options.path), new Transform({ transform(chunk: Buffer, _encoding, done) {
    compressedBytes += chunk.length;
    digest.update(chunk);
    done(null, chunk);
  } }), gunzip, fun(
    parser({ jsonStreaming: true, packStrings: false, streamStrings: true, streamKeys: false, streamNumbers: false }),
    (token: { name: string }) => {
      if (token.name === 'startObject' || token.name === 'startArray') {
        if (depth === 0) {
          if (token.name !== 'startObject') throw new Error('IDOP archive roots must be objects');
          root++;
        }
        depth++;
      } else if (token.name === 'endObject' || token.name === 'endArray') depth--;
      return token;
    },
    pick({ filter: path => {
      const key = path.join('.');
      if (!fields.has(key)) return false;
      selected = key;
      selectedRoot = root;
      return true;
    } }),
    (token: { name: string; value?: unknown }) => {
      // Only selected scalar metadata is assembled. The parser streams every
      // unselected payload string, including one larger than a JS string limit.
      // streamValues' assembler requires packed strings, so do not use it here.
      if (token.name === 'startString') { selectedString = ''; return none; }
      if (token.name === 'stringChunk') {
        selectedString += token.value as string;
        if (selectedString.length > 4096) throw new Error('IDOP archive oversized metadata');
        return none;
      }
      let value: unknown;
      if (token.name === 'endString') value = selectedString;
      else if (token.name === 'numberValue') value = Number(token.value);
      else if (token.name === 'trueValue') value = true;
      else if (token.name === 'falseValue') value = false;
      else if (token.name === 'nullValue') value = null;
      else throw new Error('IDOP archive metadata must be scalar');
      return { field: selected, root: selectedRoot, value };
    },
  )]);
  let current = -1;
  let row: Record<string, unknown> = {};
  let manifest: Record<string, unknown> | undefined;
  const owners = new Set<string>();
  const rows: Array<{ kind: 'stack' | 'refused'; ownerId: string; applied: AppliedStackRevision;
    recordSha256: string; artifactSha256?: string; refusalReason?: string }> = [];
  const refusalReasons: Record<string, number> = {};
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const finish = () => {
    if (current === 0) {
      if (row.kind !== 'manifest' || row.scope !== 'workspace-persisted-applied-anchors' ||
          row.workspaceId !== options.workspaceId || row.sourceSha256 !== options.sourceSha256 ||
          row.includesInactiveAnchors !== true || row.livenessMeasured !== false ||
          typeof row.source !== 'string' || !row.source.trim() ||
          ![row.startedAt, row.completedAt].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))) {
        throw new Error('IDOP archive manifest mismatch');
      }
      manifest = row;
      return;
    }
    if (!manifest || !['stack', 'refused'].includes(row.kind as string) || typeof row.ownerId !== 'string' ||
        !row.ownerId.trim() || owners.has(row.ownerId) || !hash(row['applied.specificationRevision']) ||
        typeof row['applied.stateRevision'] !== 'string' || !row['applied.stateRevision'].trim() ||
        !hash(row.recordSha256) || row.kind === 'stack' && !hash(row.artifactSha256) ||
        row.kind === 'refused' && (row['resolution.kind'] !== 'stale-artifact' ||
          typeof row['resolution.reason'] !== 'string' || !row['resolution.reason'].trim())) {
      throw new Error('IDOP archive population row is invalid or duplicated');
    }
    owners.add(row.ownerId);
    const entry = { kind: row.kind as 'stack' | 'refused', ownerId: row.ownerId,
      applied: { specificationRevision: row['applied.specificationRevision'], stateRevision: row['applied.stateRevision'] },
      recordSha256: row.recordSha256 };
    if (row.kind === 'stack') rows.push({ ...entry, artifactSha256: row.artifactSha256 as string });
    else {
      const reason = row['resolution.reason'] as string;
      refusalReasons[reason] = (refusalReasons[reason] ?? 0) + 1;
      rows.push({ ...entry, refusalReason: reason });
    }
    if (rows.length > options.expectedTotal) throw new Error('IDOP archive exceeds independent population');
    if (rows.length % 100 === 0) options.onProgress?.(rows.length, compressedBytes);
  };
  try {
    for await (const item of input as AsyncIterable<{ field: string; root: number; value: unknown }>) {
      if (item.root !== current) {
        if (current >= 0) finish();
        if (item.root !== current + 1) throw new Error('IDOP archive omitted a root record');
        current = item.root;
        row = {};
      }
      if (Object.hasOwn(row, item.field) || typeof item.value === 'string' && item.value.length > 4096) {
        throw new Error('IDOP archive duplicate or oversized metadata');
      }
      row[item.field] = item.value;
    }
    if (current < 0 || root !== current || depth !== 0) throw new Error('IDOP archive incomplete');
    finish();
    if (!manifest || rows.length !== options.expectedTotal) throw new Error('IDOP archive population omitted expected records');
    const outputSha256 = digest.digest('hex');
    if (options.expectedOutputSha256 && outputSha256 !== options.expectedOutputSha256) throw new Error('IDOP archive digest mismatch');
    const stacks = rows.filter(row => row.kind === 'stack').length;
    return { manifest, outputSha256, compressedBytes, total: rows.length, stacks,
      refused: rows.length - stacks, refusalReasons, populationSha256: sha256(JSON.stringify(rows)), rows };
  } finally {
    input.destroy();
  }
}

export type IdopPermissionDifference = {
  id: string;
  inputSha256: string;
  beforeSha256: string;
  afterSha256: string;
  authorityRefs: string[];
};

export const IDOP_P001_DIFFERENCES_REL = 'docs/evidence/idop-p001-expected-permission-differences.json';
const idopPlanSlug = 'identity-definitions-own-policy-2026-10-17';
const idopAuthorityRef = z.string().regex(/^identity-definitions-own-policy-2026-10-17#(?:R|D)-\d+$/);
const idopDifferenceSchema = z.object({
  id: z.string().min(1).refine(id => id === id.trim()),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  beforeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  authorityRefs: z.array(idopAuthorityRef).min(1),
}).strict();
const idopDifferenceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  plan: z.literal(idopPlanSlug),
  baselineRevision: z.string().regex(/^[a-f0-9]{40}$/),
  scopes: z.array(z.object({
    id: z.string().min(1).refine(id => id === id.trim()),
    expectation: z.string().min(1).refine(text => text === text.trim()),
    authorityRefs: z.array(idopAuthorityRef).min(1),
    differences: z.array(idopDifferenceSchema),
  }).strict()).min(1),
}).strict();

/** Read the requirement-authored allowance, never derive one from evaluator
 * output. A manifest scope is a bounded comparison claim: selecting it does not
 * certify other surfaces or runtime coverage. The caller independently loads
 * the old arm, passes its exact revision, and records this file's byte digest.
 * Case membership and exact expected input/output digests remain enforced by
 * runIdopP001PermissionComparison, including stale/unused allowances. */
export function readIdopP001ExpectedPermissionDifferences(options: {
  root: string; baselineRevision: string; scope: string;
}) {
  const bytes = readFileSync(join(options.root, IDOP_P001_DIFFERENCES_REL));
  const manifest = idopDifferenceManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (manifest.baselineRevision !== options.baselineRevision ||
      new Set(manifest.scopes.map(scope => scope.id)).size !== manifest.scopes.length) {
    throw new Error('IDOP difference manifest has a substituted baseline or duplicate scope');
  }
  for (const scope of manifest.scopes) {
    if (new Set(scope.differences.map(entry => entry.id)).size !== scope.differences.length ||
        new Set(scope.authorityRefs).size !== scope.authorityRefs.length ||
        scope.differences.some(entry => new Set(entry.authorityRefs).size !== entry.authorityRefs.length)) {
      throw new Error('IDOP difference manifest has duplicate allowances or authority references');
    }
  }
  const scope = manifest.scopes.find(scope => scope.id === options.scope);
  if (!scope) throw new Error('IDOP difference manifest does not cover the requested comparison scope');
  return { ...scope, baselineRevision: manifest.baselineRevision,
    path: IDOP_P001_DIFFERENCES_REL, sha256: sha256(bytes) };
}

function comparisonJson(value: ComparisonJson): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, comparisonJson).join(',')}]`;
  if (typeof value === 'object' && value &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${comparisonJson(value[key])}`).join(',')}}`;
  }
  throw new Error('IDOP comparison requires complete JSON values');
}

/** D-043 comparison mechanism. Adapters must independently enumerate the current
 * population and load the pinned old/current permission readers. This mechanism
 * cannot establish either adapter's source provenance or full plan acceptance.
 * Exact input/output digests make an allowance incapable of hiding another delta. */
export async function runIdopP001PermissionComparison(options: {
  population: () => readonly string[];
  enumerate: () => readonly { id: string; input: ComparisonJson }[];
  before: (input: ComparisonJson, id: string) => ComparisonJson | Promise<ComparisonJson>;
  after: (input: ComparisonJson, id: string) => ComparisonJson | Promise<ComparisonJson>;
  manifest: readonly IdopPermissionDifference[];
}) {
  const population = [...options.population()].sort();
  const cases = options.enumerate();
  const unique = (ids: readonly string[]) => ids.every(id => id.trim() === id && id.length > 0) &&
    new Set(ids).size === ids.length;
  if (!population.length || !unique(population) || !unique(cases.map(row => row.id)) ||
      comparisonJson(population) !== comparisonJson(cases.map(row => row.id).sort())) {
    throw new Error('IDOP comparison population is empty, duplicated or incompletely enumerated');
  }
  const manifest = new Map<string, IdopPermissionDifference>();
  for (const entry of options.manifest) {
    if (manifest.has(entry.id) || !population.includes(entry.id) ||
        ![entry.inputSha256, entry.beforeSha256, entry.afterSha256].every(hash => /^[a-f0-9]{64}$/.test(hash)) ||
        !entry.authorityRefs.length || !entry.authorityRefs.every(ref => /^[a-z0-9][a-z0-9-]*#(?:R|D)-\d+$/.test(ref))) {
      throw new Error('IDOP comparison manifest requires unique current cases, exact digests and requirement/decision references');
    }
    manifest.set(entry.id, entry);
  }
  const checked: Array<Omit<IdopPermissionDifference, 'authorityRefs'>> = [];
  const differences: IdopPermissionDifference[] = [];
  const unexpected: string[] = [];
  const used = new Set<string>();
  for (const row of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
    const input = comparisonJson(row.input);
    // Each reader gets its own copy of the same bytes. Mutation by the old
    // implementation must not contaminate the candidate's input or the census.
    const before = comparisonJson(await options.before(JSON.parse(input), row.id));
    const after = comparisonJson(await options.after(JSON.parse(input), row.id));
    const result = { id: row.id, inputSha256: sha256(input), beforeSha256: sha256(before), afterSha256: sha256(after) };
    checked.push(result);
    if (before === after) continue;
    const allowed = manifest.get(row.id);
    const authorized = allowed && allowed.inputSha256 === result.inputSha256 &&
      allowed.beforeSha256 === result.beforeSha256 && allowed.afterSha256 === result.afterSha256;
    differences.push({ ...result, authorityRefs: authorized ? [...allowed.authorityRefs] : [] });
    if (authorized) used.add(row.id);
    else unexpected.push(row.id);
  }
  const unusedManifest = [...manifest.keys()].filter(id => !used.has(id)).sort();
  return { passed: !unexpected.length && !unusedManifest.length, population, checked, differences, unexpected, unusedManifest };
}

export const RUNTIME_OBSERVATIONS: Observation[] = [
  { identity: 'su.mode-auto', stackRefs: ['autonomy:su.mode-auto'], ownerId: 'su-7a61b3ed-841b-4d7c-b177-f87c76073391', nativeSessionId: '01a16441-1bb3-7882-8c8f-69bfe2cddb16', activationEventId: 87801, observedAt: '2026-10-22T15:35:51.100747Z', principal: 'system:superuser', status: 'observed' },
  { identity: 'papercup.audience-engineer', stackRefs: ['audience:papercup.audience-engineer'], ownerId: 'su-afaffb1c-c265-4cb5-a71e-cbacf7b4ec85', nativeSessionId: '01a16461-be32-7870-ad38-42bd7cb2a49b', toolInvocationId: 43032599, observedAt: '2026-10-22T16:11:52.254Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/04241dbb-3d43-43ae-96fb-cbcef7587411/result-door-1792685512258.md' },
  { identity: 'judge-grading-integrity', stackRefs: ['practice:judge-grading-integrity'], ownerId: 'su-86efb84d-fbd6-4007-98a1-f8e054ccdfd4', nativeSessionId: '01a16461-be99-7a71-a6b7-2c4e9c247c2d', toolInvocationId: 43032600, observedAt: '2026-10-22T16:11:52.266Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/9b9d01b4-5ed8-46fe-bd2f-666e205a612a/result-door-1792685512270.md' },
  { identity: 'research-steward', stackRefs: ['domain:research-steward'], ownerId: 'su-be25082a-1b8a-4f4b-b097-1b3f5165727f', nativeSessionId: '01a16461-bf1a-7622-b133-f81d3d8e3304', toolInvocationId: 43032616, observedAt: '2026-10-22T16:11:55.590Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/facc7688-887f-4dc1-8067-16529fe493e8/result-door-1792685515594.md' },
  { identity: 'judge-domain', stackRefs: ['domain:judge-domain'], ownerId: 'su-c3c0b1e6-c190-4abd-b543-801e26292824', nativeSessionId: '01a16461-be2d-70b1-b111-119b5ad7cebf', toolInvocationId: 43033038, observedAt: '2026-10-22T16:13:01.553Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/5b6db70d-a7d6-4881-88d3-5c4f0215acd1/result-door-1792685581558.md' },
  { identity: 'judge-ensemble', stackRefs: ['practice:judge-ensemble'], ownerId: 'su-c7e6e19c-c281-4e6f-b106-ea2f72a81255', nativeSessionId: '01a16464-8aef-7382-89de-9cda5ea357e5', toolInvocationId: 43034113, observedAt: '2026-10-22T16:15:32.078Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/37e33f85-4fed-482e-8632-be3da3e186b7/result-door-1792685732082.md' },
  { identity: 'operator.audience-engineer', stackRefs: ['audience:operator.audience-engineer'], ownerId: 'su-8b79e88e-4682-4e23-81f0-f48e8c470473', nativeSessionId: '01a16463-84c3-7d03-978e-7303d77fbb9c', toolInvocationId: 43036259, observedAt: '2026-10-22T16:19:51.809Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/200248fa-0446-43da-9125-a39573817348/result-door-1792685991815.md' },
  { identity: 'judge-gym', stackRefs: ['practice:judge-gym'], ownerId: 'su-7403dff7-ecd1-4549-a0ad-f7ab2b882f83', nativeSessionId: '01a16463-8337-7521-ad8c-e5af96e5f09d', toolInvocationId: 43036260, observedAt: '2026-10-22T16:19:53.046Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/d928aad8-69e9-41d4-ada5-510d611aec2e/result-door-1792685993050.md' },
  { identity: 'blueprint-operation-worker', stackRefs: ['domain:blueprint-operation-worker'], ownerId: 'su-31c2b870-5080-4406-8a7d-c960f9e54aaa', nativeSessionId: null, toolInvocationId: 43036688, observedAt: '2026-10-22T16:21:09.975Z', principal: 'loopback', status: 'tool-refused', refusal: 'agent_tools:list returned role-not-allowed' },
  { identity: 'su.mode-goal', stackRefs: ['goal:su.mode-goal'], ownerId: 'su-d1800dfa-4da2-45b3-86fd-09f1e3120db9', nativeSessionId: '01a16464-8a9a-7ab2-89ac-89d9634e0705', toolInvocationId: 43036691, observedAt: '2026-10-22T16:21:10.814Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/90f3eb59-8166-49e6-8858-861123cf4188/result-door-1792686070819.md' },
  { identity: 'papercup.audience-novice', stackRefs: ['audience:papercup.audience-novice'], ownerId: 'su-10052bd8-7413-4fba-96e2-c7d78ffb5f57', nativeSessionId: '01a16464-8e7c-7bb2-8ab3-f1ecf388cd86', toolInvocationId: 43036702, observedAt: '2026-10-22T16:21:11.206Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/bf3b31d4-930d-4654-beab-9bf0e1ec7637/result-door-1792686071213.md' },
  { identity: 'su.mode-test', stackRefs: ['test:su.mode-test'], ownerId: 'su-af12cd24-704d-4594-9ddd-ee73dd556571', nativeSessionId: null, toolInvocationId: 43036704, observedAt: '2026-10-22T16:21:13.139Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/e240ca0d-021a-4da5-88f8-7380319e14ce/result-door-1792686073142.md' },
  { identity: 'su.mode-grade', stackRefs: ['grade:su.mode-grade'], ownerId: 'su-9b64fd17-7089-4b81-9302-d3539c800255', nativeSessionId: '01a16464-a13f-7b03-9004-e069c62172a5', toolInvocationId: 43036713, observedAt: '2026-10-22T16:21:13.277Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/8b184eb7-689b-468b-8b32-e8e9e7123bde/result-door-1792686073279.md' },
  { identity: 'operator.audience-novice', stackRefs: ['audience:operator.audience-novice'], ownerId: 'su-d22cfeff-524c-4558-8aa1-de07236b4ff5', nativeSessionId: '01a16464-d7b9-7e12-80e3-a996bcf668cd', toolInvocationId: 43036725, observedAt: '2026-10-22T16:21:16.250Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/cb5e377c-0d66-478b-9cf7-355a67bf5d53/result-door-1792686076257.md' },
  { identity: 'su.mode-drain', stackRefs: ['objective:su.mode-drain'], ownerId: 'su-97533b6c-b337-4f3f-a764-bb6879c9509c', nativeSessionId: '01a16464-8cb4-72b2-8ea7-aeaf0656cee8', toolInvocationId: 43036854, observedAt: '2026-10-22T16:21:34.048Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/233845b6-4c5f-4449-ba74-fc47f7d22adf/result-door-1792686094051.md' },
  { identity: 'judge-acceptance', stackRefs: ['practice:judge-acceptance'], ownerId: 'su-f9320b8d-e34e-4680-8c95-8c5fca7e15ce', nativeSessionId: '01a16463-8479-7193-891e-a65deb499ea9', toolInvocationId: 43039339, observedAt: '2026-10-22T16:28:10.930Z', principal: 'loopback', status: 'observed', outputRef: 'papercusp://scratch/papercusp-workspace/agent_tools:list/a27c844b-0d3a-4159-9f0c-6c1df8fa31a6/result-door-1792686490935.md' },
  ...['scout.lens-analogical', 'scout.lens-constraint-removal', 'scout.lens-first-principles', 'scout.lens-reframing'].map((identity): Observation => ({ identity, stackRefs: [`practice:${identity}`], ownerId: 'launch-refused', nativeSessionId: null, observedAt: '2026-10-22T17:01:40Z', principal: 'loopback', status: 'launch-refused', refusal: `bootstrap-su HTTP 400: selected SU identity ${identity} is missing practice document` })),
  { identity: 'su.specialist-planner', stackRefs: ['practice:su.specialist-planner'], ownerId: 'launch-refused', nativeSessionId: null, observedAt: '2026-10-22T17:01:40Z', principal: 'loopback', status: 'launch-refused', refusal: 'bootstrap-su HTTP 500: composition compiler prompt-missing specialist:su.planner' },
];

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const root = moduleRepoRoot(import.meta.url);

function builtInIdentities() {
  const dir = join(root, 'libs/papercusp/packages/harness/blueprints');
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name, 'blueprint.yaml');
    let raw: Record<string, unknown>;
    try { raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return []; }
    return Array.isArray(raw.slots) ? [{ id: String(raw.id), path: path.slice(root.length + 1), slots: raw.slots }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function launchedToolSchemas(promptsDir: string) {
  return readdirSync(promptsDir).filter((name) => /^tool-.*\.md$/.test(name)).sort().flatMap((name) => {
    const text = readFileSync(join(promptsDir, name), 'utf8');
    const tool = text.match(/`([^`]+)` tool on this MCP server/)?.[1];
    const schemaText = text.match(/Tool input JSON Schema:\n```json\n([\s\S]*?)\n```/)?.[1];
    if (!tool || !schemaText) return [];
    const schema = JSON.parse(schemaText) as unknown;
    return [{ name: tool, schema, schemaSha256: sha256(JSON.stringify(schema)) }];
  });
}

export function buildIdopP001Baseline(promptsDir: string) {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024,
  }).trim();
  const prompt = readFileSync(join(root, IDOP_P001_PROMPT_REL));
  const identities = builtInIdentities();
  const tools = launchedToolSchemas(promptsDir);
  return {
    schemaVersion: 1,
    plan: 'identity-definitions-own-policy-2026-10-17',
    item: 'P-001',
    capturedAt: '2026-10-22T17:03:00Z',
    base: { commit: head, promptPath: IDOP_P001_PROMPT_REL, promptGitBlob: execFileSync('git', ['-C', root, 'hash-object', IDOP_P001_PROMPT_REL], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024,
    }).trim(), promptSha256: sha256(prompt), promptBytes: prompt.length },
    population: { roles: [{ id: 'infra-reviewer' }, { id: 'security-reviewer' }], roleCount: 2, builtInIdentities: identities, builtInIdentityCount: identities.length },
    toolCatalog: { sourceKind: 'real-launched-codex-managed-tool-prompts', sourceDirectory: promptsDir, count: tools.length, digest: sha256(JSON.stringify(tools)), tools },
    observations: RUNTIME_OBSERVATIONS,
    suVariationFinding: 'Modes and fleet posture did not add grants; tool-policy differences observed are principal/role and mode-narrowing effects, not layer grants (D-009).',
    overrideChannels: ['PAPERCUSP_SU_* / launch environment', '?superuser=1 legacy query parameter', 'principal.kind / authenticated principal', 'role envelope', 'mode registry', 'fleet posture'],
    vault: {
      baseline: { grantTerms: 'all effects; no expiry; no per-use approval', afterReadHolds: 'off', transcriptVisibility: 'open, including originating agent', automaticRecall: 'on' },
      evidence: ['identity-definitions-own-policy-2026-10-17#D-006', 'packages/operator-core/lib/personal-vault/disclosure-ledger.ts:244-285', 'packages/operator-core/lib/personal-vault/transcript-exclusion.ts:106-113'],
      supersededBy: 'identity-definitions-own-policy-2026-10-17#D-020',
    },
    answers: {
      baseKnobsAndParams: 'Identity composition extends base and therefore applies base knobs/params before slotted contributions.',
      governanceSeesWornIdentity: 'No. session-governance judges model/provider/data-use from launch records but does not consume the worn identity stack; D-020 requires unification.',
      p016AndP019: 'P-016 is newly blocked work added by D-020; no P-019 exists in the current IDOP plan.',
      directoryGroups: 'No directory-group wearer authority exists in wearer-authority.ts; it resolves launch role and capability ceilings only.',
      secrets: 'Secret scope is planned stack state; current launch materialization remains host/launch-path specific rather than an identity-stack binding.',
      installConsent: 'One consent binds the exact installed artifact hash plus its computed subject set, not each layer or installed stack independently.',
      consentAndProviderCapacity: 'Consent subjects include grants and pot provider bindings. Provider bindings cannot store per-layer grant decisions or stack settings; those remain unimplemented.',
    },
    knownDefect: 'EI-26700090355079325',
  };
}

if (isCliEntry(import.meta.url)) {
  const promptsDir = process.argv[2];
  if (!promptsDir) throw new Error('usage: tsx idop-p001-baseline.ts <launched-codex-prompts-dir>');
  const target = join(root, IDOP_P001_BASELINE_REL);
  if (existsSync(target)) throw new Error('The pre-implementation baseline is frozen; append receipt evidence separately instead of overwriting it');
  const baseline = buildIdopP001Baseline(promptsDir);
  const coverage = inspectIdopP001Coverage(baseline);
  if (!coverage.complete) throw new Error(`Incomplete baseline coverage: ${JSON.stringify(coverage)}`);
  writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
}
