/** P-004: source identity views over the existing blueprint loader and file catalog. */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import {
  parseBlueprintSourceDocument,
  resolveBlueprintSource,
  RunnableBlueprintSchema,
} from '@papercusp/orchestrator/blueprint';
import { parseBlueprintSource, resolveAndValidate } from '../agent-tools/blueprint/_resolve';
import {
  availableBlueprintSources,
  INSTALLED_BLUEPRINTS_DIR,
  operatorResolveExtends,
} from '../blueprint/installed-blueprints';

export interface IdentitySourceOptions {
  repoDir?: string;
  sourcePath?: string;
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

export function inspectIdentitySource(raw: Record<string, unknown>, opts: IdentitySourceOptions = {}) {
  try {
    const parsed = parseBlueprintSourceDocument(raw);
    if (parsed.kind !== 'identity') {
      return { ok: false as const, error: 'not-an-identity', message: 'The source document must declare its own slots; inherited slots do not make its root an identity.' };
    }
    const resolver = operatorResolveExtends({ localDirs: localDirs(opts.repoDir) });
    const result = resolveBlueprintSource(raw, {
      resolve: resolver,
      sourcePath: opts.sourcePath,
      // Respect the operator's configured installed root as well as the
      // loader's built-in trust classification (including test/temp homes).
      lint: {
        requireAttestation: (layer) => layer.trust === 'installed' ||
          ('sourcePath' in layer && typeof layer.sourcePath === 'string' && inInstalledTier(layer.sourcePath)),
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
          if (!validation.errors.some(e => e.code === issue.code)) validation.errors.push(issue);
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
      layers: result.layers.map(layer => ({ id: layer.id, sourceKind: layer.sourceKind, sourcePath: layer.sourcePath, contentHash: layer.contentHash, slots: layer.slots })),
    };
  } catch (error) {
    return identityFailure(error);
  }
}

/** Id lookup uses the blueprint resolver, never a separate identity store. */
export async function getIdentitySource(id: string, opts: IdentitySourceOptions = {}) {
  try {
    const resolver = operatorResolveExtends({ localDirs: localDirs(opts.repoDir) });
    const file = resolver(id);
    if (!file) return { ok: false as const, error: 'identity-not-found', id };
    return inspectIdentitySource(parseBlueprintSource(await readFile(file, 'utf8')), { ...opts, sourcePath: file });
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
  const remaining = sources.filter(entry => !opts.after || entry.id.localeCompare(opts.after) > 0);
  const page = remaining.slice(0, Math.min(100, Math.max(1, opts.limit ?? 30)));
  const entries = await Promise.all(page.map(async entry => {
    try {
      const parsed = parseBlueprintSourceDocument(parseBlueprintSource(await readFile(entry.file, 'utf8')));
      if (parsed.kind !== 'identity') return { kind: 'blueprint' as const };
      const doc = parsed.document;
      return { kind: 'identity' as const, value: { id: entry.id, sourceId: doc.id, tier: entry.tier, version: doc.version, description: doc.description, slots: doc.slots, sourcePath: entry.file } };
    } catch (error) {
      return { kind: 'unreadable' as const, value: { id: entry.id, tier: entry.tier, sourcePath: entry.file, error: error instanceof Error ? error.message : String(error) } };
    }
  }));
  const identities = entries.flatMap(entry => entry.kind === 'identity' ? [entry.value] : []);
  const unreadable = entries.flatMap(entry => entry.kind === 'unreadable' ? [entry.value] : []);
  return {
    ok: true,
    identities,
    unreadable,
    count: identities.length,
    scanned: page.length,
    nextAfter: remaining.length > page.length ? page[page.length - 1]!.id : null,
  };
}
