/** P-004: source identity views over the existing blueprint loader and file catalog. */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import {
  parseBlueprintSourceDocument,
  BlueprintSourceDocumentSchema,
  blueprintPackageInputs,
  builtinBlueprintPath,
  compileAgentSpecification,
  modeCatalogFromValidatedSources,
  resolveBuiltinExtends,
  resolveBlueprintSource,
  RunnableBlueprintSchema,
  SU_MODE_DOCUMENTS,
  type ModeCatalogSnapshot,
  type ResolvedAgentInput,
  slotSpec,
} from '@papercusp/orchestrator/blueprint';
import { parseBlueprintSource, resolveAndValidate } from '../agent-tools/blueprint/_resolve';
import { buildBlueprintReleaseArchive, readBlueprintLifecycle } from '../cupboard/blueprint-release';
import { compileBlueprintWithPackages, resolveBlueprintPackageInputs } from '../blueprint/compile-packages';
import { resolveSeedPackKey } from '../knowledge-packs/seed-pack-key';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import {
  availableBlueprintSources,
  INSTALLED_BLUEPRINTS_DIR,
  operatorResolveExtends,
} from '../blueprint/installed-blueprints';

export interface IdentitySourceOptions {
  repoDir?: string;
  sourcePath?: string;
}

let selectedModeCatalogCache: { fingerprint: string; value: ModeCatalogSnapshot } | null = null;

async function fileStamp(file: string): Promise<string> {
  const info = await stat(file).catch(() => null);
  return info ? `${file}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` : `${file}:missing`;
}

async function treeStamps(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await treeStamps(path));
    else out.push(await fileStamp(path));
  }
  return out.sort();
}

async function selectedModeFingerprint(installed: ReturnType<typeof availableBlueprintSources>): Promise<string> {
  const builtins = await Promise.all(SU_MODE_DOCUMENTS.flatMap(({ id, slot }) => [
    builtinBlueprintPath(id), join(dirname(builtinBlueprintPath(id)), 'prompts', `${slot}.md`),
  ]).map(fileStamp));
  const active = await Promise.all(installed.filter((entry) => entry.tier === 'installed').map(async (entry) => [
    entry.id,
    await fileStamp(join(INSTALLED_BLUEPRINTS_DIR(), '.releases', entry.id, 'index.json')),
    ...await treeStamps(dirname(entry.file)),
  ]));
  return JSON.stringify([INSTALLED_BLUEPRINTS_DIR(), builtins, active]);
}

function localDirs(repoDir?: string): string[] {
  return repoDir ? [join(resolvePath(repoDir), '.papercusp', 'blueprints')] : [];
}

function inInstalledTier(file: string | null): boolean {
  if (!file) return false;
  const rel = relative(INSTALLED_BLUEPRINTS_DIR(), file);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function identityFailure(error: unknown) {
  return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
}

function inspectIdentitySourceWithApproval(
  raw: Record<string, unknown>, opts: IdentitySourceOptions,
  approvedModePolicyRef: string | null,
) {
  try {
    const parsed = parseBlueprintSourceDocument(raw);
    if (parsed.kind !== 'identity') {
      return {
        ok: false as const,
        error: 'not-an-identity',
        message: 'The source document must declare its own slots; inherited slots do not make its root an identity.',
      };
    }
    const resolver = operatorResolveExtends({ localDirs: localDirs(opts.repoDir) });
    const result = resolveBlueprintSource(raw, {
      resolve: resolver,
      sourcePath: opts.sourcePath,
      // Respect the operator's configured installed root as well as the
      // loader's built-in trust classification (including test/temp homes).
      lint: {
        approvedModePolicyRefs: approvedModePolicyRef ? [approvedModePolicyRef] : [],
        requireAttestation: (layer) =>
          (layer.trust === 'installed' ||
           ('sourcePath' in layer && typeof layer.sourcePath === 'string' && inInstalledTier(layer.sourcePath))) &&
          !(approvedModePolicyRef && layer.id === parsed.document.id),
      },
    });
    const validation = result.validation;
    const runnable = RunnableBlueprintSchema.safeParse(result.merged).success;
    if (runnable) {
      // Keep op/role registration and runnable semantic checks on the same
      // authoring path as blueprint:create/validate. Abstract modules skip it.
      const execution = resolveAndValidate(raw, resolver);
      if (execution.validation) {
        for (const issue of execution.validation.errors) {
          if (!validation.errors.some((e) => e.code === issue.code)) validation.errors.push(issue);
        }
        validation.warnings.push(...execution.validation.warnings);
      } else if (execution.parseError) {
        validation.errors.push({ level: 'error', code: 'runnable-validation', message: execution.parseError });
      }
    }
    validation.ok = validation.errors.length === 0;
    const root = result.layers[result.layers.length - 1]!;
    return {
      ok: validation.ok,
      sourceKind: parsed.kind,
      identity: parsed.document,
      sourcePath: opts.sourcePath ?? null,
      contentHash: root.contentHash,
      contentHashScope: 'source-document' as const,
      runnable,
      errors: validation.errors,
      warnings: validation.warnings,
      layers: result.layers.map((layer) => ({
        id: layer.id,
        sourceKind: layer.sourceKind,
        sourcePath: layer.sourcePath,
        contentHash: layer.contentHash,
        slots: layer.slots,
      })),
    };
  } catch (error) {
    return identityFailure(error);
  }
}

export function inspectIdentitySource(raw: Record<string, unknown>, opts: IdentitySourceOptions = {}) {
  return inspectIdentitySourceWithApproval(raw, opts, null);
}

/** The moderated receipt is useful only while the ACTIVE files still hash to
 * the exact full closure the Cupboard approved. A publisher's manifest field is
 * never read as administrator approval. */
async function verifiedInstalledModePolicy(
  id: string, file: string, raw: Record<string, unknown>,
): Promise<{ policyRef: string | null; stale: boolean }> {
  if (!inInstalledTier(file)) return { policyRef: null, stale: false };
  const active = (await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), id)).active;
  const approval = active?.modePolicyApproval;
  if (!active || !approval) return { policyRef: null, stale: false };
  if (approval.artifactContentHash !== active.artifactContentHash) return { policyRef: null, stale: true };
  try {
    const resolver = operatorResolveExtends();
    const source = resolveBlueprintSource(raw, {
      resolve: resolver,
      sourcePath: file,
      lint: {
        approvedModePolicyRefs: [approval.policyRef],
        requireAttestation: (layer) => layer.trust === 'installed' && layer.id !== id,
      },
    });
    if (!source.validation.ok) return { policyRef: null, stale: true };
    const document = BlueprintSourceDocumentSchema.parse(source.merged);
    if (document.mode?.policyRef !== approval.policyRef) return { policyRef: null, stale: true };
    const requests: Array<{ kind: string; ref: string; version?: string }> = [...(document.bundles ?? [])];
    const knowledge = resolveSeedPackKey(document).packId;
    if (knowledge && !requests.some((request) => request.kind === 'knowledge-pack' && request.ref === knowledge)) {
      requests.push({ kind: 'knowledge-pack', ref: knowledge });
    }
    const packages = await resolveBlueprintPackageInputs(requests);
    const archive = buildBlueprintReleaseArchive([...packages, ...blueprintPackageInputs(source, packages)], id);
    return archive.root.contentHash === active.contentHash && archive.package.rootHash === active.artifactContentHash
      ? { policyRef: approval.policyRef, stale: false }
      : { policyRef: null, stale: true };
  } catch {
    return { policyRef: null, stale: true };
  }
}

/** Select modes from the ordinary blueprint catalog. Built-ins establish the
 * baseline; each installed replacement must carry an exact prior revision and
 * an installer-owned approval for its full current package closure. */
export async function getSelectedModeCatalog() {
  const available = availableBlueprintSources();
  const fingerprint = await selectedModeFingerprint(available);
  if (selectedModeCatalogCache?.fingerprint === fingerprint) return selectedModeCatalogCache.value;
  const builtins = await Promise.all(SU_MODE_DOCUMENTS.map(async ({ id }) => {
    const file = builtinBlueprintPath(id);
    return resolveBlueprintSource(parseBlueprintSource(await readFile(file, 'utf8')), {
      sourcePath: file, resolve: resolveBuiltinExtends,
    });
  }));
  const installed = [];
  const approvedPolicyRefs = new Set<string>();
  const approvedInstalledSourceHashes = new Map<string, string>();
  const resolver = operatorResolveExtends();
  for (const entry of available.filter((source) => source.tier === 'installed')) {
    const raw = parseBlueprintSource(await readFile(entry.file, 'utf8'));
    if (!raw.mode) continue;
    const approval = await verifiedInstalledModePolicy(entry.id, entry.file, raw);
    if (!approval.policyRef || approval.stale) {
      throw new Error(`installed mode "${entry.id}" has no current moderated release approval`);
    }
    const source = resolveBlueprintSource(raw, {
      sourcePath: entry.file,
      resolve: resolver,
      lint: {
        approvedModePolicyRefs: [approval.policyRef],
        requireAttestation: (layer) => layer.trust === 'installed' && layer.id !== entry.id,
      },
    });
    installed.push(source);
    approvedPolicyRefs.add(approval.policyRef);
    const root = source.layers.at(-1)!;
    approvedInstalledSourceHashes.set(root.id, root.contentHash);
  }
  const selected = modeCatalogFromValidatedSources([...builtins, ...installed], {
    supportedPolicyRefs: SU_MODE_DOCUMENTS.flatMap((document) => document.modes),
    approvedModePolicyRefs: approvedPolicyRefs,
    approvedInstalledSourceHashes,
  });
  selectedModeCatalogCache = { fingerprint, value: selected };
  return selected;
}

export interface SelectedModeDefinition {
  modeId: string;
  contract: string;
  contractRevision: string;
  sourceId: string;
  sourceRevision: string;
  catalogRevision: string;
  definitionHash: string;
}

/** Resolve one approved catalog snapshot, then read each selected definition
 * once. A changed source or prompt refuses instead of silently serving the
 * built-in text under an installed identity's selected id. */
export async function getSelectedModeDefinitions(modeIds: readonly string[]): Promise<Map<string, SelectedModeDefinition>> {
  const catalog = await getSelectedModeCatalog();
  const unique = [...new Set(modeIds)];
  const definitions = await Promise.all(unique.map(async (modeId) => {
    const catalogId = modeId === 'cold-auto' ? 'auto' : modeId;
    const entry = catalog.entries.find((candidate) => candidate.id === catalogId);
    if (!entry || entry.definition.source !== 'fixed' || entry.definition.inputKind !== 'prompt-file') {
      throw new Error('mode ' + modeId + ' has no selected fixed definition');
    }
    const identity = await getIdentitySource(entry.sourceId);
    if (!identity.ok || !identity.sourcePath || identity.contentHash !== entry.sourceHash) {
      throw new Error('selected mode ' + modeId + ' source revision is unavailable or stale');
    }
    const path = join(dirname(identity.sourcePath), 'prompts', entry.slot + '.md');
    const definition = await readFile(path, 'utf8');
    const hash = createHash('sha256').update(definition).digest('hex');
    if (hash !== entry.definitionHash) {
      throw new Error('selected mode ' + modeId + ' definition changed after catalog resolution');
    }
    let contract = definition;
    if (modeId === 'cold-auto') {
      const heading = '## COLD AUTO — the same autonomy component across fresh-context wakes';
      const start = definition.indexOf(heading);
      if (start < 0) throw new Error('selected AUTO identity has no COLD AUTO carry rider');
      contract = definition.slice(start).trimEnd();
    }
    return [modeId, {
      modeId, contract, contractRevision: createHash('sha256').update(contract).digest('hex'),
      sourceId: entry.sourceId, sourceRevision: entry.sourceHash,
      catalogRevision: catalog.revision, definitionHash: entry.definitionHash,
    }] as const;
  }));
  return new Map(definitions);
}

export interface ProducedIdentityOutput {
  contributionId: string;
  value?: unknown;
  omission?: { reason: 'ineligible' | 'not-requested' | 'unavailable'; errorRef?: string };
}

/** Pin a set of outputs already produced for one selected identity. The same
 * compiler validates fixed prompt files, provider output and explicit absences
 * together; the caller keeps delivering the original values through its sink. */
interface BindSelectedIdentityOutputsInput {
  identityId: string;
  /** Local selected identities resolve through the same project root as launch. */
  repoDir?: string;
  /** The SU's static fleet-posture binding currently resolves from the built-in
   * harness; an unrelated installed catalog shadow is not this session's layer. */
  sourceTier?: 'builtin' | 'selected';
  outputs: readonly ProducedIdentityOutput[];
  scope: Record<string, unknown>;
  observedAt: string;
}

async function bindSelectedIdentityOutputsWithArtifact(input: BindSelectedIdentityOutputsInput) {
  if (input.outputs.length === 0) throw new Error('identity binding needs a produced output or omission');
  let sourcePath: string | null;
  if (input.sourceTier === 'builtin') sourcePath = builtinBlueprintPath(input.identityId);
  else {
    const identity = await getIdentitySource(input.identityId, { repoDir: input.repoDir });
    if (!identity.ok) {
      throw new Error('selected identity ' + input.identityId + ' is unavailable: ' +
        identity.error + ('errors' in identity ? ' ' + JSON.stringify(identity.errors) : ''));
    }
    sourcePath = identity.sourcePath;
  }
  if (!sourcePath) throw new Error(`selected identity ${input.identityId} is unavailable`);
  const resolver = input.sourceTier === 'builtin' ? resolveBuiltinExtends
    : operatorResolveExtends({ localDirs: localDirs(input.repoDir) });
  const raw = parseBlueprintSource(await readFile(sourcePath, 'utf8'));
  const source = resolveBlueprintSource(raw, { sourcePath, resolve: resolver });
  if (!source.validation.ok) throw new Error(`selected identity ${input.identityId} is invalid`);
  const selectedModeId = input.sourceTier !== 'builtin' && input.identityId.startsWith('su.mode-')
    ? input.identityId.slice('su.mode-'.length) : null;
  const selectedMode = selectedModeId
    ? (await getSelectedModeDefinitions([selectedModeId])).get(selectedModeId) : undefined;
  if (selectedModeId && (!selectedMode || selectedMode.sourceRevision !== source.layers.at(-1)!.contentHash)) {
    throw new Error(`selected mode ${selectedModeId} definition does not match the identity source`);
  }
  const declarations = raw.contributions as Array<{
    id: string; purpose: string; source: string; inputKind: string; ref: string;
    producerRef?: string; availability?: string;
  }> | undefined;
  const byId = new Map((declarations ?? []).map((entry) => [entry.id, entry]));
  const supplied = new Set<string>();
  const settings: Array<{ ref: string; revision: string; value: unknown; producerRef: string }> = [];
  const closure: ResolvedAgentInput[] = [];
  const omissions: Array<{ id: string; reason: 'ineligible' | 'not-requested' | 'unavailable'; errorRef?: string }> = [];
  const receipts: Array<{ contributionId: string; producerRef: string; outputRevision: string | null; status: string }> = [];
  for (const output of input.outputs) {
    const selected = byId.get(output.contributionId);
    if (!selected || selected.source !== 'provider' || !selected.producerRef ||
        !((selected.purpose === 'operational' && selected.inputKind === 'setting') ||
          (selected.purpose === 'prompt' && selected.inputKind === 'prompt-file'))) {
      throw new Error('identity ' + input.identityId + ' has no provider contribution ' + output.contributionId);
    }
    if (supplied.has(selected.id) || (output.value === undefined) === (output.omission === undefined)) {
      throw new Error('identity output needs one unique produced value or omission receipt');
    }
    supplied.add(selected.id);
    if (output.omission) {
      omissions.push({ id: selected.id, ...output.omission });
      receipts.push({ contributionId: selected.id, producerRef: selected.producerRef,
        outputRevision: null, status: 'omitted:' + output.omission.reason });
      continue;
    }
    let revision: string;
    if (selected.inputKind === 'prompt-file') {
      if (typeof output.value !== 'string' || !output.value.trim()) {
        throw new Error('identity prompt contribution needs non-empty produced text');
      }
      revision = createHash('sha256').update(output.value).digest('hex');
      closure.push({ kind: 'prompt-file', ref: selected.ref, bytes: output.value,
        contentHash: revision, producerRef: selected.producerRef });
    } else {
      revision = createHash('sha256').update(canonicalJson(output.value)).digest('hex');
      settings.push({ ref: selected.ref, revision, value: output.value,
        producerRef: selected.producerRef });
    }
    receipts.push({ contributionId: selected.id, producerRef: selected.producerRef,
      outputRevision: revision, status: 'bound' });
  }
  for (const entry of declarations ?? []) {
    if (entry.availability === 'optional' && !supplied.has(entry.id)) {
      omissions.push({ id: entry.id, reason: 'not-requested' });
    }
  }
  const definitionContributionId = (raw.mode as { definitionContributionId?: string } | undefined)
    ?.definitionContributionId;
  const selectedPromptRef = selectedMode
    ? declarations?.find((entry) => entry.id === definitionContributionId)?.ref : undefined;
  if (selectedMode && !selectedPromptRef) {
    throw new Error(`selected mode ${selectedModeId} has no fixed definition contribution`);
  }
  const fixedPrompts = (declarations ?? []).filter((entry) =>
    entry.source === 'fixed' && entry.inputKind === 'prompt-file').map((entry) => {
    const refParts = entry.ref.split(':');
    const layerId = refParts[0] === 'mode' ? refParts[1]
      : refParts[0] === 'fixed' ? source.layers.at(-1)?.id : refParts[0];
    const fileName = refParts.at(-1);
    const layer = source.layers.find((candidate) => candidate.id === layerId);
    if (!layer?.sourcePath || !fileName) {
      throw new Error('identity fixed prompt has no resolved source: ' + entry.ref);
    }
    return { ref: entry.ref, path: join(dirname(layer.sourcePath), 'prompts', fileName + '.md'),
      ...(selectedMode && entry.ref === selectedPromptRef
        ? { bytes: selectedMode.contract, contentHash: selectedMode.definitionHash } : {}) };
  });
  const compileInput = {
    source: raw,
    sourcePath,
    resolve: resolver,
    ...(fixedPrompts.length ? { promptFiles: fixedPrompts } : {}),
    settings,
    inputClosure: closure,
    contributionOmissions: omissions,
  };
  const document = BlueprintSourceDocumentSchema.parse(source.merged);
  const hasResources = Boolean(document.bundles?.length || document.grants?.requires?.length ||
    document.grants?.optional?.length || resolveSeedPackKey(document).packId);
  const workspaceId = input.scope.workspace;
  const harnessSlug = input.scope.harness;
  if (hasResources && (typeof workspaceId !== 'string' || !workspaceId.trim() ||
      typeof harnessSlug !== 'string' || !harnessSlug.trim())) {
    throw new Error('identity producer binding with resources needs workspace and harness scope');
  }
  const artifact = hasResources
    ? await compileBlueprintWithPackages(raw, {
      workspaceId: workspaceId as string, harnessSlug: harnessSlug as string,
      sourcePath, resolve: resolver, input: compileInput,
    })
    : compileAgentSpecification(compileInput);
  return {
    identityId: input.identityId,
    sourceRevision: source.layers.at(-1)!.contentHash,
    ...(selectedMode ? { definitionRevision: selectedMode.contractRevision,
      catalogRevision: selectedMode.catalogRevision } : {}),
    specificationRevision: artifact.specificationRevision,
    artifact,
    contributions: receipts,
    observedAt: input.observedAt,
    scope: input.scope,
  };
}

/** Public producer receipt for turn-start, orient and fleet metadata. The
 * full artifact carries live output bytes, so it must not ride in that metadata. */
export async function bindSelectedIdentityOutputs(input: BindSelectedIdentityOutputsInput) {
  const { artifact: _artifact, ...receipt } = await bindSelectedIdentityOutputsWithArtifact(input);
  return receipt;
}

/** Trusted launch adapter: carry the already-validated artifact into the final
 * composition without re-running the producer or exporting its live bytes. */
export async function bindSelectedIdentityOutputArtifact(input: BindSelectedIdentityOutputsInput) {
  return bindSelectedIdentityOutputsWithArtifact(input);
}

/** Compatibility wrapper for an existing operational setting sink. */
export async function bindSelectedIdentitySetting(input: {
  identityId: string;
  contributionId: string;
  sourceTier?: 'builtin' | 'selected';
  value?: unknown;
  omission?: ProducedIdentityOutput['omission'];
  scope: Record<string, unknown>;
  observedAt: string;
}) {
  const bound = await bindSelectedIdentityOutputs({
    identityId: input.identityId, sourceTier: input.sourceTier,
    outputs: [{ contributionId: input.contributionId,
      ...(input.omission ? { omission: input.omission } : { value: input.value }) }],
    scope: input.scope, observedAt: input.observedAt,
  });
  return { ...bound, ...bound.contributions[0] };
}

/** Id lookup uses the blueprint resolver, never a separate identity store. */
export async function getIdentitySource(id: string, opts: IdentitySourceOptions = {}) {
  try {
    const resolver = operatorResolveExtends({ localDirs: localDirs(opts.repoDir) });
    const file = resolver(id);
    if (!file) return { ok: false as const, error: 'identity-not-found', id };
    const raw = parseBlueprintSource(await readFile(file, 'utf8'));
    const approval = await verifiedInstalledModePolicy(id, file, raw);
    if (approval.stale) return { ok: false as const, error: 'mode-approval-stale', id };
    return inspectIdentitySourceWithApproval(raw, { ...opts, sourcePath: file }, approval.policyRef);
  } catch (error) {
    return identityFailure(error);
  }
}

/** Resolve resource declarations from the same selected identity file that
 * supplied its prompt. The existing package compiler owns pins, provider
 * bindings and failure semantics; this adapter only establishes selection and
 * refuses a source revision that changed between selection and compilation. */
export async function compileSelectedIdentityResources(input: {
  identityId: string;
  workspaceId: string;
  harnessSlug: string;
  repoDir?: string;
}) {
  const selected = await getIdentitySource(input.identityId, { repoDir: input.repoDir });
  if (!selected.ok || !selected.sourcePath) {
    throw new Error(`selected identity ${input.identityId} is unavailable for resource resolution`);
  }
  const raw = parseBlueprintSource(await readFile(selected.sourcePath, 'utf8'));
  const resolve = operatorResolveExtends({ localDirs: localDirs(input.repoDir) });
  const source = resolveBlueprintSource(raw, { sourcePath: selected.sourcePath, resolve });
  if (!source.validation.ok || source.layers.at(-1)?.contentHash !== selected.contentHash) {
    throw new Error(`selected identity ${input.identityId} source revision changed before resource resolution`);
  }
  const document = BlueprintSourceDocumentSchema.parse(source.merged);
  if (!(document.bundles?.length || document.grants?.requires?.length ||
      document.grants?.optional?.length || resolveSeedPackKey(document).packId)) return null;
  if (!input.workspaceId.trim() || !input.harnessSlug.trim()) {
    throw new Error('identity resources need an explicit workspace and harness scope');
  }
  return compileBlueprintWithPackages(raw, {
    workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
    sourcePath: selected.sourcePath, resolve,
  });
}

/**
 * Page the source catalog BEFORE reading files. Paging counts source candidates,
 * not identities: an empty identity page with nextAfter still has more sources.
 * Invalid sources stay visible instead of letting a broken shadow reveal a
 * lower-precedence installed/built-in identity.
 */
export async function listIdentitySources(opts: { repoDir?: string; after?: string; limit?: number } = {}) {
  const sources = availableBlueprintSources({ localDirs: localDirs(opts.repoDir) });
  const remaining = sources.filter((entry) => !opts.after || entry.id.localeCompare(opts.after) > 0);
  const page = remaining.slice(0, Math.min(100, Math.max(1, opts.limit ?? 30)));
  const entries = await Promise.all(
    page.map(async (entry) => {
      try {
        const parsed = parseBlueprintSourceDocument(parseBlueprintSource(await readFile(entry.file, 'utf8')));
        if (parsed.kind !== 'identity') return { kind: 'blueprint' as const };
        const doc = parsed.document;
        return {
          kind: 'identity' as const,
          value: {
            id: entry.id,
            sourceId: doc.id,
            tier: entry.tier,
            version: doc.version,
            description: doc.description,
            // The slot registry is authoritative for cardinality. Identity files
            // may omit the optional restatement, but the UI still has to choose
            // attach versus switch without carrying a second slot registry.
            slots: doc.slots.map(({ slot }) => ({
              slot,
              cardinality: slotSpec(slot)?.cardinality ?? null,
            })),
            sourcePath: entry.file,
          },
        };
      } catch (error) {
        return {
          kind: 'unreadable' as const,
          value: {
            id: entry.id,
            tier: entry.tier,
            sourcePath: entry.file,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );
  const identities = entries.flatMap((entry) => (entry.kind === 'identity' ? [entry.value] : []));
  const unreadable = entries.flatMap((entry) => (entry.kind === 'unreadable' ? [entry.value] : []));
  return {
    ok: true,
    identities,
    unreadable,
    count: identities.length,
    scanned: page.length,
    nextAfter: remaining.length > page.length ? page[page.length - 1]!.id : null,
  };
}
