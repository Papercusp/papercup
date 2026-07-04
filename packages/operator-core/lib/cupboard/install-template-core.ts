/**
 * Install a template FROM the Cupboard (app-templates-2026-07-04 P-010).
 *
 * A `kind=template` listing is GitHub-repo-backed exactly like a blueprint
 * (the Cupboard is a git-listing registry, not a tarball store): the listing
 * points at a repo whose `templates/<listing_ref>/template.yaml` (or
 * `<listing_ref>/template.yaml`, or root `template.yaml` for a
 * single-template repo) is the template. Installing it = git-clone the repo,
 * locate the template dir, VALIDATE it (`parseTemplateManifest` schema check
 * + `validateTemplateAgainstCatalog` against the kit's COMPONENT_CATALOG —
 * a stale component pin is rot and fails the install loudly, same rule the
 * anti-rot gym enforces), and place the whole dir (template.yaml + GUIDE.md +
 * blueprints/ + contracts/ + checks/ + reference/) under
 * `~/.papercusp/templates/<id>/` — where the P-011 thin materializer (the
 * scaffold "from-template" entry) reads it.
 *
 * Design of record: agent-insights/templates-system-design §Distribution.
 *
 * The core is dependency-injected (clone / installed dir / tmp) so it's
 * unit-testable without real git or network. The route
 * (`cupboard-install-template.ts`) wires the real impls.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  COMPONENT_CATALOG,
  parseTemplateManifest,
  validateTemplateAgainstCatalog,
  type TemplateManifest,
} from '@papercusp/template-kit';

export interface InstallTemplateCoreInput {
  /** The template repo's GitHub URL (https://github.com/owner/repo[.git]). */
  githubUrl: string;
  /** Within-repo template discriminator — the template id / subdir to look in first. */
  listingRef?: string;
}

export interface InstallTemplateCoreResult {
  ok: true;
  /** The installed template's id (from its template.yaml). */
  id: string;
  version: string;
  scope: TemplateManifest['scope'];
  summary: string;
  source: string;
  installedTo: string;
  /** Version-pinned component refs, verbatim from the manifest. */
  components: TemplateManifest['components'];
  /** Template ids this template is designed to stack with (P-014 semantics). */
  composesWith: string[];
  /** True when the dir ships a GUIDE.md (the composition prompt — D-007's review rationale). */
  hasGuide: boolean;
}

export interface InstallTemplateCoreDeps {
  /** Shallow-clone `url` into `dest` (which does not yet exist). Throws on failure. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  /** Absolute path of the installed-templates dir (`~/.papercusp/templates`). */
  installedTemplatesDir: () => string;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;

// A template id becomes a directory under ~/.papercusp/templates AND the
// materializer's lookup key, so it must be a safe SINGLE-SEGMENT slug — never
// a path. It is UNTRUSTED (from the cloned repo's template.yaml). The kit's
// own schema already enforces kebab-case; this belt-and-braces the path use.
const SAFE_TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export class InstallTemplateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'InstallTemplateError';
  }
}

/** Throw unless `childPath` resolves to `parentDir` itself or a path inside it. */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new InstallTemplateError(`unsafe ${label} escapes ${parentDir}`, 400);
  }
}

/** A within-repo subdir ref must be relative, charset-safe, and contain no `..`/empty segment. */
function isSafeListingRef(ref: string): boolean {
  if (!ref || ref.length > 200 || ref.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return ref.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Find the template dir within a freshly-cloned repo. Prefers the
 * `templates/<listing_ref>` subdir (the papercup official-library layout —
 * v1 source of truth, D-005), then the bare `<listing_ref>` subdir (a repo
 * hosting templates at its root level), then the repo root (single-template
 * repo).
 */
function locateTemplateDir(cloneDir: string, listingRef: string | undefined): string {
  const candidates: string[] = [];
  if (listingRef && isSafeListingRef(listingRef)) {
    for (const rel of [join('templates', listingRef), listingRef]) {
      const sub = join(cloneDir, rel);
      assertInside(cloneDir, sub, `listing_ref "${listingRef}"`);
      candidates.push(sub);
    }
  }
  candidates.push(cloneDir);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'template.yaml'))) return dir;
  }
  throw new InstallTemplateError(
    'no template.yaml found in the template repo (checked templates/<listing_ref>, <listing_ref>, and root)',
    422,
  );
}

/** Recursively copy a template dir into `target`, excluding any .git. */
async function copyTemplateDir(src: string, target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(src, target, {
    recursive: true,
    filter: (s) => !s.split(/[/\\]/).includes('.git'),
  });
}

export async function installTemplateFromCupboardCore(
  input: InstallTemplateCoreInput,
  deps: InstallTemplateCoreDeps,
): Promise<InstallTemplateCoreResult> {
  const url = (input.githubUrl ?? '').trim();
  if (!GITHUB_URL_RE.test(url)) {
    throw new InstallTemplateError(`invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`, 400);
  }

  const cloneDir = join(deps.tmpDir(), `cupboard-template-${Date.now()}-${Math.floor(performance.now())}`);
  try {
    await deps.cloneRepo(url, cloneDir);
    const tplDir = locateTemplateDir(cloneDir, input.listingRef);

    let rawParsed: unknown;
    try {
      rawParsed = parseYaml(await fs.readFile(join(tplDir, 'template.yaml'), 'utf8'));
    } catch (e) {
      throw new InstallTemplateError(
        `template.yaml failed to parse: ${e instanceof Error ? e.message : String(e)}`,
        422,
      );
    }

    // Schema validation (kit, pure): throws one Error listing EVERY problem.
    let manifest: TemplateManifest;
    try {
      manifest = parseTemplateManifest(rawParsed);
    } catch (e) {
      throw new InstallTemplateError(e instanceof Error ? e.message : String(e), 422);
    }

    // The id is UNTRUSTED (from the cloned repo) and becomes a directory we
    // `rm -rf` + `cp` into — single-segment slug only (belt-and-braces on top
    // of the kit's kebab-case rule).
    if (!SAFE_TEMPLATE_ID_RE.test(manifest.id)) {
      throw new InstallTemplateError(
        `unsafe template id ${JSON.stringify(manifest.id)} — must be a single-segment slug`,
        400,
      );
    }

    // Catalog cross-validation: every component ref must resolve AND its pin
    // must match the catalog's current version — a stale pin is rot, not
    // history (same rule the template gym re-runs on cadence).
    const catalogCheck = validateTemplateAgainstCatalog(manifest, COMPONENT_CATALOG);
    if (!catalogCheck.ok) {
      throw new InstallTemplateError(
        `template "${manifest.id}" failed catalog validation: ${catalogCheck.errors.join('; ')}`,
        422,
      );
    }

    const target = join(deps.installedTemplatesDir(), manifest.id);
    assertInside(deps.installedTemplatesDir(), target, `template id "${manifest.id}"`);
    await fs.mkdir(deps.installedTemplatesDir(), { recursive: true });
    await copyTemplateDir(tplDir, target);

    return {
      ok: true,
      id: manifest.id,
      version: manifest.version,
      scope: manifest.scope,
      summary: manifest.summary,
      source: url,
      installedTo: target,
      components: manifest.components,
      composesWith: manifest.composesWith,
      hasGuide: existsSync(join(tplDir, 'GUIDE.md')),
    };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
