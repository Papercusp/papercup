/**
 * install-from-repo — fetch a Learning Pack from a (Comb-listed) GitHub repo
 * into the local installed root (learning-packs-2026-06-11 P-017).
 *
 * Flow: shallow-clone the repo → locate the pack dir (`learning-packs/<ref>/`
 * by convention — P-016's export writes the same shape; a repo whose ROOT is a
 * pack also works) → VALIDATE through the same parser the loader uses (a
 * malformed pack never lands) → copy to `~/.papercusp/learning-packs/<id>/`
 * (overwrite = fetching a newer version) → clean up the clone.
 *
 * Fetching only stages the pack locally — it then appears in
 * learningPacks.list (creation picker + Learnings view) and installs into a
 * hive through the NORMAL conflict-review path. Nothing is injected into any
 * agent by the fetch itself.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneGithubRepo, isCloneError } from '../harness/clone-github';
import { installedLearningPacksRoot, loadLearningPackFromDir } from './load-packs';

export interface FetchPackResult {
  ok: boolean;
  error?: string;
  detail?: string;
  pack?: { id: string; title: string; version: string; itemCount: number; installedTo: string };
  warnings?: string[];
}

export async function fetchLearningPackFromRepo(opts: {
  githubUrl: string;
  /** The Comb listing_ref = the pack id/dir under `learning-packs/`. */
  listingRef?: string;
}): Promise<FetchPackResult> {
  const clonesDir = await mkdtemp(join(tmpdir(), 'pc-lp-fetch-'));
  try {
    const cloned = await cloneGithubRepo(opts.githubUrl, {
      clonesDir,
      shallow: true,
      timeoutMs: 120_000,
    });
    if (isCloneError(cloned)) {
      return { ok: false, error: cloned.code, detail: cloned.message };
    }

    // Candidate pack dirs, most specific first.
    const candidates = [
      ...(opts.listingRef ? [join(cloned.path, 'learning-packs', opts.listingRef)] : []),
      cloned.path, // a repo that IS one pack (manifest.yaml at root)
    ].filter((d) => existsSync(join(d, 'manifest.yaml')));
    if (candidates.length === 0) {
      return {
        ok: false,
        error: 'pack_not_found_in_repo',
        detail: opts.listingRef
          ? `expected learning-packs/${opts.listingRef}/manifest.yaml (or a root manifest.yaml)`
          : 'no manifest.yaml found',
      };
    }

    const { loaded, errors } = await loadLearningPackFromDir(candidates[0]);
    if (!loaded) {
      return { ok: false, error: 'pack_invalid', detail: errors.join('; ').slice(0, 400) };
    }
    if (opts.listingRef && loaded.pack.manifest.id !== opts.listingRef) {
      return {
        ok: false,
        error: 'pack_id_mismatch',
        detail: `listing_ref '${opts.listingRef}' but manifest id '${loaded.pack.manifest.id}'`,
      };
    }

    const dest = join(installedLearningPacksRoot(), loaded.pack.manifest.id);
    await rm(dest, { recursive: true, force: true });
    await cp(candidates[0], dest, { recursive: true });

    void import('../sync-sse')
      .then((m) => m.notifySyncInvalidate('learningPacks.list'))
      .catch(() => {});

    return {
      ok: true,
      pack: {
        id: loaded.pack.manifest.id,
        title: loaded.pack.manifest.title,
        version: loaded.pack.manifest.version,
        itemCount: loaded.pack.items.length,
        installedTo: dest,
      },
      ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings } : {}),
    };
  } finally {
    await rm(clonesDir, { recursive: true, force: true }).catch(() => {});
  }
}
