/**
 * bundle-app-manifest — composition + install-fanout core for a Cupboard
 * `app` listing with `delivery_type: 'bundle'`
 * (cupboard-app-distribution-2026-07-14 P-008).
 *
 * A bundle-app manifest names a composition of existing distributable units
 * (datatypes + plugins/packs + an optional blueprint) that "install" fans out
 * to the SAME per-kind installers every other Cupboard kind already uses —
 * `resolveAndInstallDeps` for plugins/packs (resolve-and-install.ts, D-002:
 * no second install runtime), `installPublishedDatatype` for datatypes
 * (datatype-registry-store.ts), and a DI'd blueprint installer for the
 * blueprint leg (install-blueprint-core.ts). Delivers the plan's "~80% of the
 * in-papercusp-app vision using only existing primitives" by composing them,
 * not reimplementing them.
 *
 * Generalizes the P-016 knowledge-pack install-time conflict review
 * (learning-packs-2026-06-11 P-009/P-010, D-003 — see
 * agent-tools/knowledge_packs/install.ts): classify every declared unit
 * against the host BEFORE installing anything, fold it into ONE combined
 * report (clean | duplicate | conflict per unit), and only auto-install the
 * clean + duplicate set; a manifest with unresolved conflicts is reported
 * but never silently auto-installed — the caller decides whether to proceed
 * (mirrors knownledge_packs:install's `review_required` gate: existing
 * content outranks an incoming pack/bundle by default).
 *
 * `surfaces` (the plan's parenthetical "(data-driven) surfaces" axis) has NO
 * installable primitive anywhere in the codebase yet (verified: no
 * data-driven-surface registry/installer exists) — it is a reserved,
 * always-empty field here, NOT wired into planning or install. Surfacing
 * rich bundle-app UI is P-009's stretch territory (its own plan if pursued).
 *
 * Pure classification + DI'd execution (same split as pack-catalog.ts /
 * resolve-and-install.ts): unit-tested with injected host-state lookups and
 * installers. The remaining IO wiring — a Cupboard listing → manifest fetch,
 * the `cupboard:install-app` agent tool, and the CupboardClient "Apps" tab
 * conflict-review UI — is tracked as the next increment on plan
 * `cupboard-app-distribution-2026-07-14` P-008 (this module is the reusable
 * core those callers wire up).
 */
import {
  resolveAndInstallDeps,
  type DepSet,
  type ResolveAndInstallDeps,
  type ResolveAndInstallResult,
} from './resolve-and-install';

/** A bundle-app manifest — the composition a `delivery_type: 'bundle'` app listing names. */
export interface BundleAppManifest {
  /** Human-facing bundle name (matches the listing title). */
  name: string;
  description?: string;
  /** Approved global datatype ids (installed via `datatypes:install`'s core). */
  datatypes?: string[];
  /** Distribution-unit pack names (installed via `resolveAndInstallDeps`). */
  packs?: string[];
  /** Distribution-unit plugin names (installed via `resolveAndInstallDeps`). */
  plugins?: string[];
  /** At most one blueprint composed into the bundle (a bundle app installs its OWN harness shape). */
  blueprint?: { id: string; githubUrl: string; listingRef?: string } | null;
  /**
   * Reserved for a future data-driven-surfaces primitive. No installer exists
   * for this axis yet (verified against the live codebase) — always ignored
   * by `planBundleAppInstall` / `installBundleApp` today. Kept typed so a
   * manifest author can declare intent without the field being silently
   * dropped by a schema round-trip.
   */
  surfaces?: unknown[];
}

export type BundleUnitKind = 'datatype' | 'pack' | 'plugin' | 'blueprint';

export interface BundleUnitClassification {
  kind: BundleUnitKind;
  /** The declared id/name (datatype id, pack/plugin unit name, or blueprint id). */
  ref: string;
  status: 'clean' | 'duplicate' | 'conflict';
  /** Present on `duplicate` (what's already there) / `conflict` (what collides). */
  detail?: string;
}

export interface BundleInstallReview {
  clean: BundleUnitClassification[];
  duplicates: BundleUnitClassification[];
  conflicts: BundleUnitClassification[];
}

/** Host-state lookups the review classifies against. Real IO wiring supplies these; tests inject fakes. */
export interface BundleHostState {
  /** Does this workspace already have datatype `id` installed locally? */
  hasDatatype: (id: string) => Promise<boolean>;
  /** The live pack/plugin catalog (same shape `resolveAndInstallDeps` classifies against). */
  deriveCatalog: ResolveAndInstallDeps['deriveCatalog'];
  /**
   * If blueprint `id` is already installed, its recorded source (github URL);
   * `null` when not installed. A recorded source that differs from the
   * manifest's `blueprint.githubUrl` is a genuine naming collision (conflict);
   * a matching source is a no-op duplicate.
   */
  installedBlueprintSource: (id: string) => Promise<string | null>;
}

function normalizeRefs(xs: string[] | undefined): string[] {
  return Array.from(new Set((xs ?? []).filter((x) => typeof x === 'string' && x.length > 0)));
}

/**
 * Classify every unit a manifest declares — datatypes, packs, plugins, and
 * the optional blueprint — into clean / duplicate / conflict, WITHOUT
 * installing anything. This is the "one conflict review" the plan calls for:
 * a single combined report spanning every kind in the bundle.
 */
export async function planBundleAppInstall(
  manifest: BundleAppManifest,
  host: BundleHostState,
): Promise<BundleInstallReview> {
  const clean: BundleUnitClassification[] = [];
  const duplicates: BundleUnitClassification[] = [];
  const conflicts: BundleUnitClassification[] = [];
  const push = (c: BundleUnitClassification) => {
    (c.status === 'clean' ? clean : c.status === 'duplicate' ? duplicates : conflicts).push(c);
  };

  for (const id of normalizeRefs(manifest.datatypes)) {
    push(
      (await host.hasDatatype(id))
        ? { kind: 'datatype', ref: id, status: 'duplicate', detail: 'already installed in this workspace' }
        : { kind: 'datatype', ref: id, status: 'clean' },
    );
  }

  // Packs/plugins share the same catalog view: 'installed' ⇒ duplicate (already
  // satisfied, resolveAndInstallDeps will silently skip it too); anything else
  // (unknown or a Cupboard-installable unit) ⇒ clean, resolveAndInstallDeps
  // resolves + installs it at execute time. Neither kind is version-tracked
  // today, so a real "conflict" is not derivable at this layer for pack/plugin
  // units — only the blueprint leg (below) can collide on identity.
  const cat = await host.deriveCatalog();
  for (const name of normalizeRefs(manifest.packs)) {
    const d = cat.view.byName.get(name);
    push(
      d?.source === 'installed'
        ? { kind: 'pack', ref: name, status: 'duplicate', detail: 'already installed' }
        : { kind: 'pack', ref: name, status: 'clean' },
    );
  }
  for (const name of normalizeRefs(manifest.plugins)) {
    const d = cat.view.byName.get(name);
    push(
      d?.source === 'installed'
        ? { kind: 'plugin', ref: name, status: 'duplicate', detail: 'already installed' }
        : { kind: 'plugin', ref: name, status: 'clean' },
    );
  }

  if (manifest.blueprint) {
    const { id, githubUrl } = manifest.blueprint;
    const existingSource = await host.installedBlueprintSource(id);
    if (existingSource == null) {
      push({ kind: 'blueprint', ref: id, status: 'clean' });
    } else if (existingSource === githubUrl) {
      push({ kind: 'blueprint', ref: id, status: 'duplicate', detail: `already installed from ${existingSource}` });
    } else {
      push({
        kind: 'blueprint',
        ref: id,
        status: 'conflict',
        detail: `id "${id}" is already installed from a different source (${existingSource}); the bundle wants ${githubUrl}`,
      });
    }
  }

  return { clean, duplicates, conflicts };
}

/** DI'd installers `installBundleApp` fans a manifest's declared units out to. */
export interface BundleAppInstallers {
  /** Reused verbatim — the SAME plugin/pack install loop every other Cupboard-installable dep uses. */
  resolveAndInstallDeps: (declared: Partial<DepSet>) => Promise<ResolveAndInstallResult>;
  /** Install one approved global datatype into the workspace (idempotent). */
  installDatatype: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Install the manifest's blueprint (no-op / error if `manifest.blueprint` is unset). */
  installBlueprint: (blueprint: NonNullable<BundleAppManifest['blueprint']>) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface BundleAppInstallResult {
  ok: boolean;
  review: BundleInstallReview;
  /** Set when `ok:false` because unresolved conflicts blocked execution — nothing was installed. */
  blockedByConflicts: boolean;
  deps: ResolveAndInstallResult | null;
  datatypes: { id: string; ok: boolean; error?: string }[];
  blueprint: { id: string; ok: boolean; error?: string } | null;
}

/**
 * Review, then install, a bundle-app manifest. Refuses to install anything
 * when the review finds unresolved conflicts (`allowConflicts` must be
 * explicitly set to proceed anyway — mirrors knowledge_packs:install's
 * default-skip-on-clash posture: existing content outranks the incoming
 * bundle unless the caller overrides it). Duplicates are skipped (already
 * satisfied); clean units are installed via the injected per-kind installers.
 */
export async function installBundleApp(
  manifest: BundleAppManifest,
  host: BundleHostState,
  installers: BundleAppInstallers,
  opts: { allowConflicts?: boolean } = {},
): Promise<BundleAppInstallResult> {
  const review = await planBundleAppInstall(manifest, host);
  if (review.conflicts.length > 0 && !opts.allowConflicts) {
    return { ok: false, review, blockedByConflicts: true, deps: null, datatypes: [], blueprint: null };
  }

  const deps = await installers.resolveAndInstallDeps({
    packs: normalizeRefs(manifest.packs),
    plugins: normalizeRefs(manifest.plugins),
  });

  const datatypes: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of normalizeRefs(manifest.datatypes)) {
    const res = await installers.installDatatype(id);
    datatypes.push(res.ok ? { id, ok: true } : { id, ok: false, error: res.error });
  }

  let blueprint: { id: string; ok: boolean; error?: string } | null = null;
  if (manifest.blueprint) {
    const res = await installers.installBlueprint(manifest.blueprint);
    blueprint = res.ok ? { id: manifest.blueprint.id, ok: true } : { id: manifest.blueprint.id, ok: false, error: res.error };
  }

  const ok = deps.ok && datatypes.every((d) => d.ok) && (blueprint == null || blueprint.ok);
  return { ok, review, blockedByConflicts: false, deps, datatypes, blueprint };
}
