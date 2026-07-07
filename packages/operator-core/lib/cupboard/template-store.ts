/**
 * Local template store (plan local-first-party-template-bundling-2026-07-07) — the
 * data layer behind the LOCAL half of the `templates:*` verbs.
 *
 * v1 ships the first-party "Papercusp Official" templates IN the app and resolves
 * them from disk (offline, no Cupboard/GitHub round-trip). The remote Cupboard
 * marketplace stays a wired-but-dormant v2 seam (flag `papercusp-templates-marketplace`).
 *
 * The store is a resolved templates root, LAYERED:
 *   - bundled (read-only): ships in-app. Release: Tauri main.rs sets
 *     PAPERCUSP_TEMPLATES_DIR → <resources>/sidecar/templates. Dev: the in-repo
 *     `templates/` dir (resolved relative to this file). Holds the first-party set.
 *   - user (writable): <papercuspRoot>/templates — EMPTY in v1; v2's
 *     `templates:install` writes marketplace templates here.
 *
 * Each template is a SELF-DESCRIBING subdir: `listing.json`
 * (ref/title/description/category/scope) + `template.yaml` + `GUIDE.md`
 * (+ `COMPONENT_CATALOG.md`). The store enumerates subdirs across layers (a user-
 * layer ref shadows a bundled one), so "install a template" is just "drop a
 * self-describing dir into the user layer" — the seam that makes v2 user-install
 * reuse this exact resolution + materialize path, with no first-party special case.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { papercuspPath } from '../papercusp-root';
import type { TemplateListing } from './templates';

/** A template resolved from the local store (a single self-describing subdir). */
export interface LocalTemplate {
  ref: string;
  id: string;
  title: string;
  description: string;
  category: string | null;
  scope: string | null;
  version: string;
  /** 'first-party' for the bundled set; v2 installs may mark 'installed'. */
  source: string;
  /** Absolute path to the template's content dir (the overlay source). */
  dir: string;
  layer: 'bundled' | 'user';
}

export interface TemplateRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

// Dev fallback for the bundled layer: the in-repo `templates/` dir. This file is
// <repo>/packages/operator-core/lib/cupboard/template-store.ts, so four levels up
// is the repo root. Mirrors harness-paths.ts's inRepoHarnessDir fallback so a
// fresh checkout (no PAPERCUSP_TEMPLATES_DIR env) still resolves the templates.
const inRepoTemplatesDir = join(
  dirname(fileURLToPath(import.meta.url)), // <repo>/packages/operator-core/lib/cupboard
  '..',
  '..',
  '..',
  '..',
  'templates',
);

/** The bundled (read-only) templates dir: env override → in-repo dev fallback. */
export function bundledTemplatesDir(): string {
  const fromEnv = process.env.PAPERCUSP_TEMPLATES_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return inRepoTemplatesDir;
}

/** The writable user templates dir (v2 install target). Empty in v1. */
export function userTemplatesDir(): string {
  return papercuspPath('templates');
}

/**
 * The layered roots, in RESOLUTION order — later layers shadow earlier ones on a
 * ref collision, so the writable user layer wins over the bundled first-party set.
 */
export function templateRoots(): TemplateRoot[] {
  return [
    { dir: bundledTemplatesDir(), layer: 'bundled' },
    { dir: userTemplatesDir(), layer: 'user' },
  ];
}

/** Read a template subdir's self-describing metadata into a LocalTemplate. */
function readTemplateDir(dir: string, ref: string, layer: 'bundled' | 'user'): LocalTemplate | null {
  const listingPath = join(dir, 'listing.json');
  const manifestPath = join(dir, 'template.yaml');
  // A template dir MUST carry a template.yaml (the manifest). listing.json is the
  // rich metadata; when absent we fall back to the manifest so a v2-installed dir
  // that only shipped template.yaml still resolves.
  const hasManifest = existsSync(manifestPath);
  const hasListing = existsSync(listingPath);
  if (!hasManifest && !hasListing) return null;

  let listing: Record<string, unknown> = {};
  if (hasListing) {
    try {
      listing = JSON.parse(readFileSync(listingPath, 'utf8')) as Record<string, unknown>;
    } catch {
      listing = {};
    }
  }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined;

  // Manifest scalars as a fallback for category/scope/id/version when listing.json
  // is thin (bounded regex over our own YAML — see gen-listings).
  let mText = '';
  if (hasManifest) {
    try {
      mText = readFileSync(manifestPath, 'utf8');
    } catch {
      mText = '';
    }
  }
  const yscalar = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(mText);
    return m ? m[1].replace(/^["']|["']$/g, '').trim() || undefined : undefined;
  };

  const id = str(listing.id) ?? yscalar('id') ?? ref;
  return {
    ref,
    id,
    title: str(listing.title) ?? id,
    description: str(listing.description) ?? '',
    category: str(listing.category) ?? yscalar('category') ?? null,
    scope: str(listing.scope) ?? yscalar('scope') ?? null,
    version: str(listing.version) ?? yscalar('version') ?? '0.1.0',
    source: str(listing.source) ?? (layer === 'user' ? 'installed' : 'first-party'),
    dir,
    layer,
  };
}

/**
 * Enumerate every template across the layered roots. A user-layer ref shadows a
 * bundled one. Non-dir entries (README.md) and dirs without a manifest are skipped.
 */
export function listLocalTemplates(roots: TemplateRoot[] = templateRoots()): LocalTemplate[] {
  const byRef = new Map<string, LocalTemplate>();
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const ref of entries) {
      const dir = join(root.dir, ref);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      const t = readTemplateDir(dir, ref, root.layer);
      if (t) byRef.set(ref, t); // later root (user) overwrites earlier (bundled)
    }
  }
  return [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Resolve one template by ref (or id) from the local store, or null. */
export function resolveLocalTemplate(
  idOrRef: string,
  roots: TemplateRoot[] = templateRoots(),
): LocalTemplate | null {
  const key = (idOrRef ?? '').trim();
  if (!key) return null;
  const all = listLocalTemplates(roots);
  return all.find((t) => t.ref === key || t.id === key) ?? null;
}

// ── GUIDE read (local mirror of fetchTemplateGuide) ───────────────────────────

/** Guide payloads land in an agent's context — cap the biggest field (matches remote). */
const GUIDE_MAX_CHARS = 60_000;

export interface LocalTemplateGuide {
  ref: string;
  /** 'local' — the store analog of fetchTemplateGuide's git branch. */
  branch: string;
  guide: string;
  guideTruncated: boolean;
  componentCatalog: string | null;
  manifest: string | null;
  fetchedFiles: string[];
}

function readFileOrNull(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Read GUIDE.md (+ COMPONENT_CATALOG.md + template.yaml) from a local template dir. */
export function readLocalGuide(
  t: Pick<LocalTemplate, 'ref' | 'dir'>,
): LocalTemplateGuide | { error: string; status: number } {
  const rawGuide = readFileOrNull(join(t.dir, 'GUIDE.md'));
  if (rawGuide == null) {
    return { error: `GUIDE.md not found for local template "${t.ref}"`, status: 404 };
  }
  const componentCatalog = readFileOrNull(join(t.dir, 'COMPONENT_CATALOG.md'));
  const manifest =
    readFileOrNull(join(t.dir, 'template.yaml')) ?? readFileOrNull(join(t.dir, 'template.yml'));
  const guideTruncated = rawGuide.length > GUIDE_MAX_CHARS;
  const guide = guideTruncated ? rawGuide.slice(0, GUIDE_MAX_CHARS) : rawGuide;
  const fetchedFiles = ['GUIDE.md'];
  if (componentCatalog) fetchedFiles.push('COMPONENT_CATALOG.md');
  if (manifest) fetchedFiles.push(existsSync(join(t.dir, 'template.yaml')) ? 'template.yaml' : 'template.yml');
  return { ref: t.ref, branch: 'local', guide, guideTruncated, componentCatalog, manifest, fetchedFiles };
}

/**
 * Normalize a LocalTemplate to the same TemplateListing shape the remote Cupboard
 * path returns, so `templates:list` can present local + (v2) remote uniformly.
 * `githubUrl` is empty for a local template (the content is on-disk, not cloned).
 */
export function toTemplateListing(t: LocalTemplate): TemplateListing {
  return {
    id: t.id,
    ref: t.ref,
    title: t.title,
    description: t.description,
    githubUrl: '',
    category: t.category ?? undefined,
    scope: t.scope ?? undefined,
    reviewStatus: t.source === 'first-party' ? 'official' : 'local',
  };
}
