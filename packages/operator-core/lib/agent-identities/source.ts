/** P-004: source identity views over the existing blueprint loader and file catalog. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import {
  parseBlueprintSourceDocument,
  BlueprintSourceDocumentSchema,
  blueprintPackageInputs,
  builtinBlueprintPath,
  modeCatalogFromValidatedSources,
  resolveBuiltinExtends,
  resolveBlueprintSource,
  RunnableBlueprintSchema,
  SU_MODE_DOCUMENTS,
  type ModeCatalogSnapshot,
  slotSpec,
} from '@papercusp/orchestrator/blueprint';
import { parseBlueprintSource, resolveAndValidate } from '../agent-tools/blueprint/_resolve';
import { buildBlueprintReleaseArchive, readBlueprintLifecycle } from '../cupboard/blueprint-release';
import { resolveBlueprintPackageInputs } from '../blueprint/compile-packages';
import { resolveSeedPackKey } from '../knowledge-packs/seed-pack-key';
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
