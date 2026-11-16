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
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { isCliEntry } from '../util/cli-entry';
import { moduleRepoRoot } from '../module-repo-root';
import { parse as parseYaml } from 'yaml';
import { build, transformSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
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
import type { listIdentitySources } from './source';

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
  const sourceFunction = <T,>(path: string, name: string, bindings: Record<string, unknown>): T => {
    const source = sourceAt(path);
    const file = ts.createSourceFile(path, source.text, ts.ScriptTarget.Latest, true);
    const matches = file.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
    if (matches.length !== 1 || !matches[0].body) throw new Error(`IDOP missing canonical host function: ${path}#${name}`);
    const declaration = matches[0].getText(file);
    hostFunctions.set(`${path}#${name}`, { path, name, sha256: sha256(declaration) });
    const module = { exports: undefined as unknown };
    const code = transformSync(`${declaration}\nmodule.exports = ${name};`, {
      loader: 'ts', format: 'cjs', target: 'node22', sourcefile: path,
    }).code;
    runInNewContext(code, { ...bindings, module, exports: {}, Date, console }, { filename: path, timeout: 2_000 });
    if (typeof module.exports !== 'function') throw new Error(`IDOP invalid canonical host function: ${name}`);
    return module.exports as T;
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
export async function loadIdopP001DispatchPermissionReader(options: { root: string; revision: string }) {
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
  const locations = new Map<string, { repo: string; revision: string; prefix: string }>();
  const sources = new Map<string, { path: string; revision: string; sha256: string }>();
  const sourceTexts = new Map<string, string>();
  const read = (path: string): string => {
    const cached = sourceTexts.get(path);
    if (cached !== undefined) return cached;
    const directory = Object.values(packages).find(prefix => path.startsWith(prefix + '/'));
    if (!directory) throw new Error(`IDOP dispatch comparison unpinned source: ${path}`);
    let location = locations.get(directory);
    if (!location) {
      const tree = current ? [] : git(options.root, ['ls-tree', options.revision, directory]).trim().split(/\s+/);
      const nested = tree[0] === '160000';
      if (!current && !/^[a-f0-9]{40}$/.test(tree[2] ?? '')) throw new Error(`IDOP missing source pin: ${directory}`);
      location = { repo: nested ? join(options.root, directory) : options.root,
        revision: current ? 'working-tree' : nested ? tree[2] : options.revision,
        prefix: nested ? directory + '/' : '' };
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
    stdin: { contents: "export { preflightDispatchStack } from '@papercusp/tooldef/dispatch-stack';",
      sourcefile: 'idop-preflight-entry.ts', resolveDir: options.root },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent',
    plugins: [{ name: 'idop-pinned-source', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (/^(zod|zod-to-json-schema|mingo)(\/|$)/.test(args.path)) {
          const name = args.path.split('/')[0];
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
          path = `${packages[name]}/src/${args.path === name ? 'index' : args.path.slice(name.length + 1)}`;
        }
        const candidates = /\.[cm]?[jt]s$/.test(path) ? [path.replace(/\.js$/, '.ts')] : [`${path}.ts`, `${path}/index.ts`];
        for (const candidate of candidates) {
          try { read(candidate); return { path: candidate, namespace: 'idop-source' }; }
          catch (error) {
            if (candidate === candidates.at(-1)) throw error;
          }
        }
        throw new Error(`IDOP unreadable dispatch import: ${args.path}`);
      });
      builder.onLoad({ filter: /.*/, namespace: 'idop-source' }, args => ({ contents: read(args.path), loader: 'ts' }));
    } }],
  });
  const module = { exports: {} as Record<string, unknown> };
  const noTimer = () => { throw new Error('IDOP preflight attempted to own a timer'); };
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: (name: string) => {
      if (!allowedImports.has(name)) throw new Error(`IDOP dispatch comparison unpinned runtime import: ${name}`);
      return require(name);
    },
    AbortController, AbortSignal, TextEncoder, TextDecoder, URL, structuredClone,
    process: { env: Object.freeze({}) }, setTimeout: noTimer, setInterval: noTimer,
    clearTimeout: noTimer, clearInterval: noTimer,
  }, { filename: 'idop-pinned-preflight.cjs', timeout: 10_000 });
  if (typeof module.exports.preflightDispatchStack !== 'function') throw new Error('IDOP missing canonical dispatch preflight');
  const preflight = module.exports.preflightDispatchStack as typeof preflightDispatchStack;
  return { revision: options.revision, packageLockSha256: sha256(lockText),
    sources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)),
    externalDependencies: [...external.values()].sort((a, b) => a.name.localeCompare(b.name)),
    evaluate: async (...args: Parameters<typeof preflightDispatchStack>) =>
      JSON.parse(JSON.stringify(await preflight(...args))) as Awaited<ReturnType<typeof preflightDispatchStack>>,
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
 * identity must not become an apparently complete census. This is still a
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
  const pages: Array<{ after: string | null; scanned: number; ids: string[]; nextAfter: string | null }> = [];
  // One empty read is still needed to verify that an empty source snapshot is
  // also empty on the independent library path.
  for (let offset = 0; offset === 0 || offset < sources.length; offset += 100) {
    const candidates = sources.slice(offset, offset + 100);
    const after = offset ? sources[offset - 1].id : undefined;
    const expectedNext = offset + 100 < sources.length ? candidates.at(-1)!.id : null;
    const page = await deps.page({ repoDir: options.root, after, limit: 100 });
    if (!page.ok || page.unreadable.length || page.scanned !== candidates.length ||
        page.count !== page.identities.length || page.nextAfter !== expectedNext) {
      throw new Error(`IDOP current library incomplete or unreadable page after ${after ?? '<start>'}`);
    }
    const expected = candidates.filter(source => source.kind === 'identity');
    if (page.identities.length !== expected.length || page.identities.some((identity, index) => {
      const source = expected[index];
      return !source || identity.id !== source.id || identity.sourceId !== source.sourceId ||
        identity.tier !== source.tier || identity.sourcePath !== source.file ||
        !/^[a-f0-9]{64}$/.test(identity.sourceRevision) ||
        comparisonJson(identity.slots.map(slot => slot.slot).sort()) !== comparisonJson(source.slots);
    })) throw new Error('IDOP current library omitted or substituted an identity');
    identities.push(...page.identities);
    pages.push({ after: after ?? null, scanned: page.scanned,
      ids: page.identities.map(identity => identity.id), nextAfter: page.nextAfter });
  }
  if (comparisonJson(sources) !== comparisonJson(snapshot()) ||
      comparisonJson(JSON.parse(JSON.stringify(roles))) !== comparisonJson(JSON.parse(JSON.stringify(registry())))) {
    throw new Error('IDOP current library changed during enumeration');
  }
  return { scope: 'selected-library-and-enabled-plugin-role-source' as const,
    liveWearersIncluded: false as const, harnessSlug: options.harnessSlug,
    identities, roles, pages, sources };
}

type AppliedStackRevision = { specificationRevision: string; stateRevision: string };
type AppliedStackDependencies = {
  anchors: () => Promise<Array<{ ownerId: string; applied: unknown }>>;
  record: (ownerId: string, workspaceId: string, revision: AppliedStackRevision) => Promise<unknown>;
};

/** Snapshot every persisted applied anchor in this workspace, including parked
 * or ended wearers. Use the SAME gate-selected launch-record/receipt resolver as
 * execution: a newer desired artifact must never replace the applied one, and a
 * control-only transition may still resolve the current specification. No
 * liveness claim or selected-library join is implied by this source adapter.
 */
export async function readIdopP001AppliedStackPopulation(
  workspaceId: string,
  dependencies?: AppliedStackDependencies,
) {
  if (!workspaceId.trim() || workspaceId !== workspaceId.trim()) throw new Error('IDOP applied stacks require a workspace');
  const [{ appliedOrCurrentIdentityArtifact, selectAppliedReceipt }, { identityWearerRole }] = await Promise.all([
    import('../capability-envelope/identity-grants-port'), import('./wearer-authority'),
  ]);
  const deps = dependencies ?? await (async () => {
    const [{ getOrgPg }, { readGateSelectedLaunchSpec }] = await Promise.all([
      import('@papercusp/db-org'), import('../agent-tools/coordination/control-anchor'),
    ]);
    const sql = getOrgPg().sql;
    return {
      anchors: () => sql<Array<{ ownerId: string; applied: unknown }>>`
        SELECT owner_id AS "ownerId", control_state->'activation'->'applied' AS applied
          FROM harness_shared.session_briefs
         WHERE workspace_id = ${workspaceId}
           AND control_state->'activation'->'applied' IS NOT NULL
           AND control_state->'activation'->'applied' <> 'null'::jsonb
         ORDER BY owner_id`,
      record: (ownerId: string, scope: string, revision: AppliedStackRevision) =>
        readGateSelectedLaunchSpec(sql, ownerId, scope, [revision]),
    };
  })();
  const snapshot = async () => {
    const rows = await deps.anchors();
    if (new Set(rows.map(row => row.ownerId)).size !== rows.length) throw new Error('IDOP duplicate applied owner');
    return rows.map(row => {
      const revision = row.applied as Partial<AppliedStackRevision> | null;
      if (!row.ownerId.trim() || row.ownerId !== row.ownerId.trim() ||
          typeof revision?.specificationRevision !== 'string' || !/^[a-f0-9]{64}$/.test(revision.specificationRevision) ||
          typeof revision.stateRevision !== 'string' || !/^[a-f0-9]{64}$/.test(revision.stateRevision)) {
        throw new Error(`IDOP malformed applied anchor: ${row.ownerId}`);
      }
      return { ownerId: row.ownerId, applied: { specificationRevision: revision.specificationRevision,
        stateRevision: revision.stateRevision } };
    }).sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  };
  const anchors = await snapshot();
  const stacks = [];
  for (const anchor of anchors) {
    const raw = await deps.record(anchor.ownerId, workspaceId, anchor.applied);
    const artifact = appliedOrCurrentIdentityArtifact(raw, anchor.applied);
    if (!artifact) throw new Error(`IDOP applied artifact unreadable: ${anchor.ownerId}`);
    const receipt = selectAppliedReceipt(raw, anchor.applied) ?? raw;
    const stack = receipt && typeof receipt === 'object' ? (receipt as { stack?: unknown }).stack : undefined;
    if (stack !== undefined && (!Array.isArray(stack) || stack.some(ref => typeof ref !== 'string' || !ref.trim()))) {
      throw new Error(`IDOP malformed applied stack: ${anchor.ownerId}`);
    }
    stacks.push({ ...anchor, role: identityWearerRole(raw),
      explicitStack: (stack ?? []) as string[],
      artifactSha256: sha256(JSON.stringify(artifact)),
      layers: artifact.inputs.filter(input => input.kind === 'blueprint-layer')
        .map(({ ref, revision, contentHash, sourceKind }) => ({ ref, revision, contentHash, sourceKind })),
      artifact });
  }
  if (comparisonJson(anchors) !== comparisonJson(await snapshot())) {
    throw new Error('IDOP applied anchors changed during enumeration');
  }
  return { scope: 'workspace-persisted-applied-anchors' as const, workspaceId,
    includesInactiveAnchors: true as const, livenessMeasured: false as const, stacks };
}

export type IdopPermissionDifference = {
  id: string;
  inputSha256: string;
  beforeSha256: string;
  afterSha256: string;
  authorityRefs: string[];
};

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
